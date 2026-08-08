import sys
from mcp_server import server as mcp
print('python', sys.executable)
print('import_ok', hasattr(mcp, 'run'))
print('dir', sorted([n for n in dir(mcp) if not n.startswith('_')]))
print('has_tool_names', hasattr(mcp, 'tool_names'))
print('has_tools', hasattr(mcp, 'tools'))
try:
    print('tools', [t.name for t in mcp.tools])
except Exception as exc:
    print('tools_error', exc)
