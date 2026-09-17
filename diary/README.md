# Work diary

A plain written record of what Isadora and Phil got done each day on Bloom House.
Highlights, not a changelog. Git history already has every commit; this is the
part a person would want to read back in a month.

## How it's laid out

One file per person per day:

```
diary/2026-09-17-isadora.md
diary/2026-09-17-phil.md
```

Separate files on purpose. Phil works on his own branch and opens PRs, Isadora
mostly works on `consolidation`. If both of us wrote into one shared file we'd
get a merge conflict nearly every day. Two files never collide, and `ls diary`
still reads in date order with both of us side by side.

Whose file it is comes from `git config user.name` (lowercased, first name).

## What goes in an entry

```markdown
# 2026-09-17 · Isadora

## Done
- What shipped or got fixed, in a sentence each. Say why it mattered if that isn't obvious.

## Found
- Anything we learned about the code or the data that surprised us.

## Decided
- Calls made, and the reason. These are the ones that get forgotten.

## Open
- What's left hanging at the end of the day.
```

Skip any heading with nothing under it. Commit hashes and file paths are welcome
but keep it readable. Write it like you're telling the other person over coffee.

## Who writes it

Claude does, in both our sessions. The rule lives in `CLAUDE.md` under "Work
diary", so any Claude Code session in this repo picks it up. We can edit or add
to our own files by hand whenever we like.
