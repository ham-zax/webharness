# Source attribution

This ChatGPT skill is an adaptation of:

- Repository: `https://github.com/danium/lateral-thinking`
- Author / copyright holder: danium
- Source license: MIT License, Copyright (c) 2026 danium
- Source structure: one `lateral` router plus eight sibling technique skills.

## Adaptation notes

The source repository packages each technique as a sibling skill. This adaptation consolidates the bundle into one ChatGPT skill so there is a single `SKILL.md` entrypoint. The router remains in the root skill and each technique is stored as a lazily loaded reference file.

The adaptation preserves the source's key behavior: one technique per pass, bounded batches, visible abandonments or empty branches, and an explicit meta-pattern scan after each session. Supporting source pools and question banks are condensed into the relevant reference files so the skill remains self-contained.
