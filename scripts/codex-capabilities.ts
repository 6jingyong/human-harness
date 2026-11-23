import { inspectCodexCapabilities } from '../src/executors/codex';

try {
  const inventory = await inspectCodexCapabilities({ includeMcp: process.argv.includes('--mcp') });
  process.stdout.write(JSON.stringify(inventory, null, 2) + '\n');
  if (!inventory.skills.ok || !inventory.plugins.ok || inventory.mcp?.ok === false) process.exitCode = 1;
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
