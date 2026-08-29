import asyncio
import os

import mcp_shell_server.command_validator as validator

relaxed = os.environ.get("MCP_SHELL_ALLOW_DANGEROUS", "")
names = {n.strip() for n in relaxed.split(",") if n.strip()}
if "ALL" in names:
    validator.DANGEROUS_COMMANDS.clear()
    validator.CommandValidator._validate_default_argument_policy = (
        lambda self, command: None
    )
    validator.CommandValidator.validate_no_shell_operators = (
        lambda self, cmd: None
    )
    import mcp_shell_server.command_preprocessor as preproc

    _orig_parse = preproc.CommandPreProcessor.parse_command

    def _parse_relaxed(self, command):
        mapping = {}
        relaxed = []
        for i, tok in enumerate(command):
            if tok in ("|", ";", "&&", "||"):
                ph = f"__MCP_SHELL_OP_{i}__"
                mapping[ph] = tok
                relaxed.append(ph)
            else:
                relaxed.append(tok)
        cmd, redirects = _orig_parse(self, relaxed)
        return [mapping.get(t, t) for t in cmd], redirects

    preproc.CommandPreProcessor.parse_command = _parse_relaxed
else:
    for name in names:
        validator.DANGEROUS_COMMANDS.discard(name)

from mcp_shell_server.server import main

asyncio.run(main())