# Instructions for LLM Coding Assistants

This file contains guidelines for AI/LLM coding assistants working on this project.

## Commit Messages

All commit messages must include:

1. **A clear description** of the changes made
2. **The AI agent/model** used to generate the changes (e.g., "Claude Sonnet 4 (Anthropic, 2025)")
3. **The user prompts** that led to the changes

Format:
```
<descriptive commit title>

<detailed description of changes>

---
Generated with assistance from <model name> (<provider>, <year>)

User prompt(s):
- "<prompt 1>"
- "<prompt 2>"
  (include context for prompts that reference previous options/decisions)
```

**Shell Quoting**: Use heredoc quoting for commit messages and when writing test scripts to avoid shell parsing issues:

```bash
# Good: heredoc (recommended)
git commit -F - <<'EOF'
Fix UV bounds for spheres

- Detailed change 1
- Detailed change 2

---
Generated with assistance from Model Name (Provider, 2026)

User prompt(s):
- 'Prompt with "quotes" and other special chars'
EOF
```

## Chat Log Export

After **every** commit, give a written summary of what you accomplished in this session, then
export the current chat session to `agent-logs/`. Use this command exactly:
`( ../vscode-export-chat-log/export-chat-log.py --wait && git add agent-logs/ && git commit --amend --no-edit ) &`
