## Task Execution

For any task that is complex enough to take more than ~2 minutes:
- Spawn a sub-agent or background process to handle it
- Don't block the conversation
- When it's done, report back with a concise summary of what was done
