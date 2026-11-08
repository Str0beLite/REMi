import pytest

from remi import grammar
from remi.grammar import Chat, Command, GrammarError, parse

TOOL = '''Here's a tool for word counts.
/propose_tool word_count
```python
"""Count words in stdin. Usage: word_count < file"""
import sys
print(len(sys.stdin.read().split()))
```
Let me know if you want changes.'''

# (model output, expected parse)
CASES = [
    # plain chat
    ("Hello! How can I help?", Chat("Hello! How can I help?")),
    ("  \n  The build passed.  \n", Chat("The build passed.")),
    ("", Chat("")),
    ("You could run /sh ls to see the files.", Chat("You could run /sh ls to see the files.")),
    ("The binary is at\n/usr/bin/python3", Chat("The binary is at\n/usr/bin/python3")),
    ("/x is not a command name", Chat("/x is not a command name")),
    ("/Sh ls", Chat("/Sh ls")),
    # one command; surrounding text dropped
    ("/sh ls -la", Command("sh", "ls -la")),
    ("Let me check.\n/sh cat /etc/os-release\nI'll report back.", Command("sh", "cat /etc/os-release")),
    ("   /sh   echo hi   ", Command("sh", "echo hi")),
    ("`/sh df -h`", Command("sh", "df -h")),
    ("```\n/sh uname -a\n```", Command("sh", "uname -a")),
    ("/sh grep -r 'TODO' src | wc -l", Command("sh", "grep -r 'TODO' src | wc -l")),
    ("/fetch https://example.com/docs?page=2", Command("fetch", "https://example.com/docs?page=2")),
    ("/note user prefers short answers", Command("note", "user prefers short answers")),
    # first command wins
    ("/sh ls\n/sh rm -rf /\n/note done", Command("sh", "ls")),
    ("Plan:\n/fetch https://a.dev\nthen\n/sh echo b", Command("fetch", "https://a.dev")),
    # /say targets
    ("/say #general deploy is done", Command("say", "deploy is done", target="#general")),
    ("/say @sleep-remi can you review this?", Command("say", "can you review this?", target="@sleep-remi")),
    ("/say @ryan 🚀 shipped", Command("say", "🚀 shipped", target="@ryan")),
    # registry tools (unknown names parse as plain calls; the dispatcher checks they exist)
    ("/word_count < notes.txt", Command("word_count", "< notes.txt")),
    ("Running it now:\n/csv_stats", Command("csv_stats", "")),
]


@pytest.mark.parametrize(("text", "want"), CASES)
def test_parse(text, want):
    assert parse(text) == want


MALFORMED = [
    ("/sh", "needs an argument"),
    ("/fetch   ", "needs an argument"),
    ("/note", "needs an argument"),
    ("/say hello everyone", "usage: /say"),
    ("/say #general", "usage: /say"),
    ("/propose_tool word_count\nprint(1)", "needs a ```python block"),
    ("/propose_tool word_count\n```python\nprint(1)\n", "unclosed"),
    ("/propose_tool word_count\n```python\n```", "empty"),
    ("/propose_tool word_count\n```python\ndef f(:\n```", "doesn't parse"),
    ("/propose_tool sh\n```python\nprint(1)\n```", "bad tool name"),
    ("/propose_tool Word-Count\n```python\nprint(1)\n```", "bad tool name"),
    ("/propose_tool\n```python\nprint(1)\n```", "bad tool name"),
]


@pytest.mark.parametrize(("text", "reason"), MALFORMED)
def test_malformed(text, reason):
    with pytest.raises(GrammarError, match=reason):
        parse(text)


def test_propose_tool_captures_block_and_docs():
    cmd = parse(TOOL)
    assert cmd.name == "propose_tool" and cmd.args == "word_count"
    assert cmd.block == '"""Count words in stdin. Usage: word_count < file"""\nimport sys\nprint(len(sys.stdin.read().split()))'
    assert cmd.docs == "Count words in stdin. Usage: word_count < file"


def test_propose_tool_without_docstring_and_py_fence():
    cmd = parse("/propose_tool add_one\n```py\nprint(int(input()) + 1)\n```")
    assert cmd.block == "print(int(input()) + 1)" and cmd.docs == ""


def test_register_extra_command(monkeypatch):
    monkeypatch.setitem(grammar.PARSERS, "dummy", None)  # restore PARSERS after the test
    grammar.register("dummy", lambda name, args, rest: Command(name, args.upper()))
    assert parse("/dummy loss down") == Command("dummy", "LOSS DOWN")
    with pytest.raises(ValueError):
        grammar.register("Bad-Name")
