# Source and adaptation

Source: Anthropic `frontend-design` skill

- Repository: https://github.com/anthropics/skills
- Upstream path: `skills/frontend-design/`
- Upstream `SKILL.md` blob: `decdff43d05908b4c1fc2cfd2d80fc5743440934`
- License: Apache License 2.0 (`LICENSE.txt`)

Adaptation for ChatGPT Skills packaging:

- Removed the upstream `license` key from `SKILL.md` frontmatter because this package follows the ChatGPT skill-creator convention of using only `name` and `description` there.
- Added `agents/openai.yaml` for ChatGPT UI metadata.
- Preserved the upstream instructional body.
