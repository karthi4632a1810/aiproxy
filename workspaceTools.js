import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const string = description => ({ type: 'string', description });
const integer = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum });
const definition = (name, description, properties, required) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false }
} });

export const WORKSPACE_TOOLS = [
  definition('list_files', 'List files and directories in the workspace (up to 500 entries).', { path: string('Directory, relative to workspace. Default .'), recursive: { type: 'boolean' } }, []),
  definition('read_file', 'Read a UTF-8 file, optionally a range of lines (maximum 500 lines per call).', { path: string('File path'), start_line: integer('First line, 1-based', 1, 1000000), end_line: integer('Last line, inclusive', 1, 1000000) }, ['path']),
  definition('write_file', 'Create or overwrite a UTF-8 file. Parent directories are created. Read existing files before overwriting.', { path: string('File path'), content: string('Complete file contents') }, ['path', 'content']),
  definition('edit_file', 'Replace an exact string in a file. Fails if missing or ambiguous unless replace_all is true.', { path: string('File path'), old_text: string('Exact existing text'), new_text: string('Replacement text'), replace_all: { type: 'boolean' } }, ['path', 'old_text', 'new_text']),
  definition('create_directory', 'Create a directory and missing parent directories.', { path: string('Directory path') }, ['path']),
  definition('delete_path', 'Delete a file or empty directory. Nonempty directories require recursive: true. Only delete when the user task requires it.', { path: string('Path to delete'), recursive: { type: 'boolean' } }, ['path']),
  definition('search_files', 'Find a literal string in UTF-8 workspace files. Skips symlinks, .git and node_modules; bounded to 200 files and 100 matches.', { query: string('Literal search string'), path: string('Directory to search; default .') }, ['query']),
  definition('execute_command', 'Execute a shell command with cwd inside the workspace. Returns stdout, stderr and exit code. Commands have host-user permissions, not an OS sandbox. Use for builds, tests and project commands.', { command: string('Shell command'), cwd: string('Working directory relative to workspace; default .'), timeout_ms: integer('Timeout; default 30000 ms', 100, 120000) }, ['command'])
];

export function validateArguments(name, args) {
  const schema = WORKSPACE_TOOLS.find(t => t.function.name === name)?.function.parameters;
  if (!schema) throw new Error(`Unknown workspace tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  for (const field of schema.required) if (!(field in args)) throw new Error(`Missing argument: ${field}`);
  for (const [field, value] of Object.entries(args)) {
    const rule = schema.properties[field];
    if (!rule) throw new Error(`Unexpected argument: ${field}`);
    if (rule.type === 'integer' ? !Number.isInteger(value) || value < rule.minimum || value > rule.maximum : typeof value !== rule.type) throw new Error(`Invalid argument: ${field}`);
  }
}

export class WorkspaceTools {
  constructor(root) { this.root = path.resolve(root); }
  async init() {
    this.root = await fs.realpath(this.root);
    if (!(await fs.stat(this.root)).isDirectory()) throw new Error('Workspace must be a directory');
    return this;
  }
  async resolve(input = '.', { rootAllowed = true } = {}) {
    if (typeof input !== 'string' || !input || input.includes('\0')) throw new Error('Invalid workspace path');
    const target = path.resolve(this.root, input);
    const relative = path.relative(this.root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path is outside the workspace');
    if (!relative && !rootAllowed) throw new Error('Cannot modify the workspace root');
    let current = this.root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in workspace file tools');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return target;
  }
  async read(target) {
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Path must be a regular file');
      if (stat.size > MAX_FILE_BYTES) throw new Error('File exceeds 1 MiB limit');
      const data = await handle.readFile();
      if (data.includes(0)) throw new Error('Binary files are not supported');
      return data.toString('utf8');
    } finally { await handle.close(); }
  }
  async write(target, content) {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('File exceeds 1 MiB limit');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.resolve(target, { rootAllowed: false });
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1) throw new Error('Cannot write special files or hard-linked files');
      await handle.truncate(0);
      await handle.writeFile(content, 'utf8');
    } finally { await handle.close(); }
  }
  async walk(directory, recursive, limit, signal) {
    const entries = [];
    let truncated = false;
    const visit = async dir => {
      signal?.throwIfAborted();
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entries.length >= limit) { truncated = true; return; }
        const target = path.join(dir, entry.name);
        entries.push({ path: path.relative(this.root, target), type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file' });
        if (recursive && entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)) await visit(target);
      }
    };
    await visit(directory);
    return { entries, truncated };
  }
  async execute(name, args, signal) {
    signal?.throwIfAborted();
    validateArguments(name, args);
    if (name === 'execute_command') return this.command(args, signal);
    const modifying = ['write_file', 'edit_file', 'create_directory', 'delete_path'].includes(name);
    const target = await this.resolve(args.path || '.', { rootAllowed: !modifying });
    const relative = path.relative(this.root, target) || '.';
    switch (name) {
      case 'list_files': return this.walk(target, args.recursive || false, 500, signal);
      case 'read_file': {
        const lines = (await this.read(target)).split('\n');
        const start = args.start_line || 1;
        const end = Math.min(args.end_line || start + 499, start + 499, lines.length);
        if (args.end_line && args.end_line < start) throw new Error('end_line must be at or after start_line');
        const content = lines.slice(start - 1, end).join('\n');
        return { path: relative, start_line: start, end_line: end, total_lines: lines.length,
          content: content.slice(0, MAX_OUTPUT_BYTES), truncated: end < lines.length || content.length > MAX_OUTPUT_BYTES };
      }
      case 'write_file': await this.write(target, args.content); return { path: relative, bytes_written: Buffer.byteLength(args.content) };
      case 'edit_file': {
        if (!args.old_text) throw new Error('old_text must not be empty');
        const original = await this.read(target);
        const count = original.split(args.old_text).length - 1;
        if (!count) throw new Error('old_text was not found');
        if (count > 1 && !args.replace_all) throw new Error('old_text is ambiguous; provide more context or replace_all');
        const content = args.replace_all ? original.split(args.old_text).join(args.new_text) : original.replace(args.old_text, () => args.new_text);
        await this.write(target, content);
        return { path: relative, replacements: args.replace_all ? count : 1 };
      }
      case 'create_directory': await fs.mkdir(target, { recursive: true }); return { path: relative, created: true };
      case 'delete_path': {
        const stat = await fs.lstat(target);
        if (stat.isDirectory() && !args.recursive) await fs.rmdir(target);
        else await fs.rm(target, { recursive: args.recursive || false });
        return { path: relative, deleted: true };
      }
      case 'search_files': {
        if (!args.query) throw new Error('query must not be empty');
        const listing = await this.walk(target, true, 2000, signal);
        const matches = []; let scanned = 0, truncated = listing.truncated;
        for (const entry of listing.entries) {
          signal?.throwIfAborted();
          if (entry.type !== 'file') continue;
          if (scanned >= 200 || matches.length >= 100) { truncated = true; break; }
          scanned++;
          let text;
          try { text = await this.read(await this.resolve(entry.path)); } catch { continue; }
          for (const [index, line] of text.split('\n').entries()) {
            if (line.includes(args.query)) matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 500) });
            if (matches.length >= 100) { truncated = true; break; }
          }
        }
        return { matches, files_scanned: scanned, truncated };
      }
    }
  }
  async command(args, signal) {
    if (!args.command.trim()) throw new Error('command must not be empty');
    const cwd = await this.resolve(args.cwd || '.');
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('cwd must be a directory');
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.AGENT_API_KEY;
      const child = spawn(process.env.AGENT_SHELL || '/bin/bash', ['-c', args.command], {
        cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
      });
      let bytes = 0, timedOut = false, truncated = false, stdout = [], stderr = [];
      const kill = () => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, args.timeout_ms || 30000);
      const abort = () => kill();
      signal?.addEventListener('abort', abort, { once: true });
      const capture = chunks => chunk => {
        const remaining = MAX_OUTPUT_BYTES - bytes;
        if (remaining > 0) { const kept = chunk.subarray(0, remaining); chunks.push(kept); bytes += kept.length; }
        if (chunk.length > remaining) { truncated = true; kill(); }
      };
      child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', (code, exitSignal) => {
        cleanup(); kill(); // No background process may outlive this command.
        if (signal?.aborted) return reject(signal.reason || new Error('Command cancelled'));
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
          exit_code: code, signal: exitSignal, timed_out: timedOut, truncated, cwd: path.relative(this.root, cwd) || '.' });
      });
      if (signal?.aborted) abort();
    });
  }
}
