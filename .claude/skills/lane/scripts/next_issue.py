#!/usr/bin/env python3
"""Print the next unblocked, unclaimed issue for a lane.

Usage: next_issue.py <web|core|gpu|contract>   (or --self-test)
Exit 0: prints "<number>\t<title>".
Exit 2: nothing unblocked; prints open blockers, most-waited-on first.
Exit 3: no open unclaimed issues in the lane.
"""
import json
import re
import subprocess
import sys
from collections import Counter

# status:blocked is not a claim: once its blockers close, the issue is pickable again.
CLAIMED = {"status:in-progress"}
PRIORITY = "priority:high"


def gh(*args):
    return json.loads(subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout)


def blockers(body):
    """Issue numbers listed under the '## Blocked by' heading."""
    m = re.search(r"^##\s*Blocked by\s*$(.*?)(?=^##\s|\Z)", body or "", re.M | re.S | re.I)
    return [int(n) for n in re.findall(r"#(\d+)", m.group(1))] if m else []


def choose(issues, open_numbers):
    """Return (issue, waiting_counter). issue is None when nothing is unblocked."""
    waiting = Counter()
    # priority:high first, then oldest first
    for i in sorted(issues, key=lambda i: (PRIORITY not in {label["name"] for label in i["labels"]}, i["number"])):
        if CLAIMED & {label["name"] for label in i["labels"]}:
            continue
        open_blockers = [b for b in blockers(i["body"]) if b in open_numbers]
        if not open_blockers:
            return i, waiting
        waiting.update(open_blockers)
    return None, waiting


def self_test():
    body = "## Goal\nx\n## Blocked by\n#3, #7\n## Done when\n- [ ] #99 not a blocker\n"
    assert blockers(body) == [3, 7]
    assert blockers("## Blocked by\nnone\n") == []
    assert blockers("no headings") == []
    lab = lambda *n: [{"name": x} for x in n]
    issues = [
        {"number": 5, "title": "a", "labels": lab("lane:core"), "body": body},
        {"number": 6, "title": "b", "labels": lab("lane:core", "status:in-progress"), "body": ""},
        {"number": 8, "title": "c", "labels": lab("lane:core"), "body": "## Blocked by\n#3\n"},
    ]
    assert choose(issues, {3, 7})[0] is None
    assert choose(issues, {3, 7})[1].most_common(1) == [(3, 2)]
    assert choose(issues, {7})[0]["number"] == 8
    assert choose(issues, set())[0]["number"] == 5
    issues.append({"number": 9, "title": "d", "labels": lab("lane:core", "priority:high"), "body": ""})
    assert choose(issues, set())[0]["number"] == 9
    print("ok")


def main():
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    lane = sys.argv[1]
    issues = gh("issue", "list", "--label", f"lane:{lane}", "--state", "open", "--limit", "200",
                "--json", "number,title,labels,body")
    open_numbers = {i["number"] for i in gh("issue", "list", "--state", "open", "--limit", "500", "--json", "number")}
    issue, waiting = choose(issues, open_numbers)
    if issue:
        print(f"{issue['number']}\t{issue['title']}")
    elif waiting:
        print("Blocked. Open blockers, most-waited-on first:")
        for n, count in waiting.most_common():
            print(f"#{n}\t({count} issue(s) waiting)")
        sys.exit(2)
    else:
        print(f"No open unclaimed issues in lane:{lane}.")
        sys.exit(3)


if __name__ == "__main__":
    main()
