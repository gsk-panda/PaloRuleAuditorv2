import { Client } from 'ssh2';

export interface PanoramaSshConfig {
  host: string;
  port?: number;
  username: string;
  privateKey?: string;
  password?: string;
  passphrase?: string;
}

export interface SshRuleTargets {
  ruleName: string;
  devices: string[];
}

export interface SshHitCountRow {
  ruleName: string;
  deviceName: string;
  hitCount: number;
  lastHitTimestamp: string | null;
  ruleModifyTimestamp: string | null;
}

const SSH_TIMEOUT_MS = 300000;
const SSH_TEST_TIMEOUT_MS = 15000;

const SSH_ALGORITHMS = {
  kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] as string[] },
  cipher: { append: ['aes128-cbc', 'aes256-cbc', 'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com'] as string[] },
  serverHostKey: { append: ['ssh-dss'] as string[] },
};

function buildConnectOptions(config: PanoramaSshConfig) {
  return {
    host: config.host,
    port: config.port ?? 22,
    username: config.username,
    privateKey: config.privateKey || undefined,
    password: config.password || undefined,
    passphrase: config.passphrase || undefined,
    readyTimeout: 60000,
    strictVendor: false,
    algorithms: SSH_ALGORITHMS,
  };
}

// ── Single-command exec (for simple one-shot commands) ───────────────────────
function runSshCommand(
  config: PanoramaSshConfig,
  command: string,
  label?: string,
  timeoutMs: number = SSH_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      try { conn.end(); } catch (_) {}
      if (err) reject(err);
      else resolve(output);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`SSH timeout${label ? ` (${label})` : ''} after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) return finish(new Error(`SSH exec failed${label ? ` (${label})` : ''}: ${err.message}`));
          stream
            .on('close', () => finish())
            .on('data', (data: Buffer) => { output += data.toString('utf8'); })
            .stderr?.on('data', (data: Buffer) => { output += data.toString('utf8'); });
        });
      })
      .on('error', (err) => finish(new Error(`SSH connection failed${label ? ` (${label})` : ''}: ${err.message}`)))
      .connect(buildConnectOptions(config));
  });
}

// ── Multi-command shell session (required for scripting-mode + show command) ─
// PAN-OS CLI requires scripting mode to be set in the same interactive session
// as the show command. conn.exec() cannot chain commands — we need conn.shell().
function runSshShellCommands(
  config: PanoramaSshConfig,
  commands: string[],
  label?: string,
  timeoutMs: number = SSH_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      try { conn.end(); } catch (_) {}
      if (err) reject(err);
      else resolve(output);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`SSH shell timeout${label ? ` (${label})` : ''} after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    conn
      .on('ready', () => {
        conn.shell({ term: 'dumb' }, (err, stream) => {
          if (err) return finish(new Error(`SSH shell failed${label ? ` (${label})` : ''}: ${err.message}`));
          stream
            .on('close', () => finish())
            .on('data', (data: Buffer) => { output += data.toString('utf8'); })
            .stderr?.on('data', (data: Buffer) => { output += data.toString('utf8'); });
          // Write each command then exit to close the session naturally
          for (const cmd of commands) {
            stream.write(cmd + '\n');
          }
          stream.write('exit\n');
        });
      })
      .on('error', (err) => finish(new Error(`SSH connection failed${label ? ` (${label})` : ''}: ${err.message}`)))
      .connect(buildConnectOptions(config));
  });
}

// ── SSH connectivity test ────────────────────────────────────────────────────
export async function testSshConnection(
  config: PanoramaSshConfig
): Promise<{ ok: boolean; message: string; output?: string }> {
  try {
    const output = await runSshCommand(config, 'show version', 'test', SSH_TEST_TIMEOUT_MS);
    // PAN-OS returns "Invalid user" when the CLI user isn't authorized
    if (output.includes('Invalid user') || output.includes('Please login using a valid account')) {
      return { ok: false, message: 'SSH connected but CLI user not authorized', output: output.substring(0, 500) };
    }
    return { ok: true, message: 'SSH connection successful', output: output.substring(0, 500) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ── Target parsing (from configure-mode show output) ────────────────────────
const SKIP_DEVICE_IDS = new Set(['negate', 'no', 'yes']);
const SERIAL_PATTERN = /^\d{10,}$/;

export function parseConfigureTargets(deviceGroup: string, output: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const lines = output.split('\n');
  let currentRule: string | null = null;
  let inDevices = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ruleMatch = line.match(/^\s*"([^"]+)"\s*\{?\s*$/);
    if (ruleMatch) {
      currentRule = ruleMatch[1];
      inDevices = false;
      continue;
    }
    if (line.includes('devices') && line.includes('{')) {
      inDevices = true;
      continue;
    }
    if (inDevices && currentRule) {
      const devMatch = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*;?\s*$/);
      if (devMatch) {
        const dev = devMatch[1].trim();
        if (dev && !SKIP_DEVICE_IDS.has(dev)) {
          const existing = map.get(currentRule) || [];
          if (!existing.includes(dev)) existing.push(dev);
          map.set(currentRule, existing);
        }
      }
      if (line.trim() === '}' || (line.trim().startsWith('}') && !line.includes('{'))) {
        inDevices = false;
      }
    }
    if (line.trim() === '}' || line.trim() === '};') {
      if (inDevices) inDevices = false;
    }
  }
  return map;
}

// ── Hit count table parser ───────────────────────────────────────────────────
const TOTAL_LINE = /Total Hit Count:\s*\d+/;
const HEADER_LINE = /Rule Name\s+Rule usage\s+Device Name/i;
const PROMPT_LINE = /^[\w@.-]+\([^)]*\)>\s*$/;
const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]?/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// Parse PAN-OS date strings which come in formats like:
//   "Mon Dec 15 10:30:00 2024"   (from the concatenated two-part match)
//   "2024/12/15 10:30:00"        (alternate format)
function parsePanosDate(s: string): Date | null {
  if (!s || s === '-') return null;
  // Try direct parse (works for "Mon Dec 15 10:30:00 2024" on V8)
  let d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  // Try YYYY/MM/DD HH:MM:SS
  const slashFmt = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (slashFmt) {
    d = new Date(`${slashFmt[1]}-${slashFmt[2]}-${slashFmt[3]}T${slashFmt[4]}:${slashFmt[5]}:${slashFmt[6]}`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

export function parseRuleHitCountTable(output: string): SshHitCountRow[] {
  const rows: SshHitCountRow[] = [];
  const cleaned = stripAnsi(output);
  const lines = cleaned.split('\n');
  let currentRule = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TOTAL_LINE.test(line)) continue;
    if (HEADER_LINE.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---') || trimmed.startsWith('=~=') || trimmed.startsWith('set cli') || PROMPT_LINE.test(trimmed)) continue;

    const parts = trimmed.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);

    // A data row starts with "Used" or "Unused" and has at least 4 columns
    // (State, Device, Vsys, HitCount) — we relax the >=9 requirement
    const isDataRow =
      (parts[0] === 'Used' || parts[0] === 'Unused') &&
      parts.length >= 4 &&
      parts[1] &&
      parts[1] !== 'Device Name' &&
      !/^-+$/.test(parts[1]);

    if (!isDataRow) {
      // Track current rule name from non-data lines
      if (parts[0] && parts[0] !== 'Rule' && parts[0] !== 'Rule Name' && !parts[0].startsWith('---') && parts[0] !== 'Used' && parts[0] !== 'Unused') {
        currentRule = parts[0];
      }
      continue;
    }

    const deviceNameCol = parts[1] ?? '';
    const hitCountCol = parts[3] ?? '-';

    // Collect timestamp tokens from parts[4] onward.
    // PAN-OS columns (after state/device/vsys/hits): Last Hit, First Hit, Rule Age (days - skip), Rule Modification
    // Each date is split across TWO parts: "Mon Dec" + "15 10:30:00 2024"
    const monthAbbrev = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/;
    const timePart = /^\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/;
    const fullDate = /\d{2}:\d{2}:\d{2}\s+\d{4}$/;

    const timestamps: string[] = [];
    let idx = 4;
    while (idx < parts.length && timestamps.length < 6) {
      const p = parts[idx];
      if (p === '-' || p === 'connected') break;
      if (monthAbbrev.test(p) && idx + 1 < parts.length && timePart.test(parts[idx + 1])) {
        timestamps.push(`${p} ${parts[idx + 1]}`);
        idx += 2;
      } else if (p && fullDate.test(p)) {
        timestamps.push(p);
        idx += 1;
      } else {
        idx += 1;
      }
    }

    // Column layout: [0]=Last Hit, [1]=First Hit, [2]=Rule Modification Timestamp
    // (Rule Age in "X days" is a non-date string and gets skipped by the parser above)
    const lastHitCol = timestamps[0] ?? '-';
    const ruleModifyCol = timestamps[2] ?? timestamps[1] ?? '-'; // prefer index 2, fall back to 1

    if (currentRule) {
      const hitCount = hitCountCol === '-' || hitCountCol === '' ? 0 : (parseInt(hitCountCol, 10) || 0);
      rows.push({
        ruleName: currentRule,
        deviceName: deviceNameCol,
        hitCount,
        lastHitTimestamp: lastHitCol && lastHitCol !== '-' ? lastHitCol : null,
        ruleModifyTimestamp: ruleModifyCol && ruleModifyCol !== '-' ? ruleModifyCol : null,
      });
    }
  }
  return rows;
}

// ── Public interface ─────────────────────────────────────────────────────────
export interface PanoramaRuleUseEntry {
  devicegroup?: string;
  rulename?: string;
  lastused?: string;
  hitcnt?: string;
  target?: string[];
  modificationTimestamp?: string;
}

export async function getHitCountsViaSsh(
  sshConfig: PanoramaSshConfig,
  deviceGroup: string,
  onProgress?: (message: string) => void
): Promise<PanoramaRuleUseEntry[]> {
  // Step 1: Get per-rule target devices
  onProgress?.(`SSH: Getting targets for device group ${deviceGroup}...`);
  let configureOutput: string;
  try {
    configureOutput = await runSshCommand(
      sshConfig,
      `show device-group "${deviceGroup}" pre-rulebase security rules`,
      `targets-${deviceGroup}`
    );
  } catch (err) {
    throw new Error(`SSH targets fetch failed for ${deviceGroup}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const targetsByRule = parseConfigureTargets(deviceGroup, configureOutput);

  // Step 2: Get hit counts — must use shell session so scripting-mode applies to the show command
  onProgress?.(`SSH: Getting hit counts for device group ${deviceGroup}...`);
  let hitCountOutput: string;
  try {
    hitCountOutput = await runSshShellCommands(
      sshConfig,
      [
        'set cli scripting-mode on',
        `show rule-hit-count device-group "${deviceGroup}" pre-rulebase security rules all`,
        'set cli scripting-mode off',
      ],
      `hitcount-${deviceGroup}`
    );
  } catch (err) {
    throw new Error(`SSH hit count fetch failed for ${deviceGroup}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const hitRows = parseRuleHitCountTable(hitCountOutput);

  const entries: PanoramaRuleUseEntry[] = [];
  const targetsAreSerials = (devices: string[]) =>
    devices.length > 0 && devices.every((d) => SERIAL_PATTERN.test(d));

  for (const row of hitRows) {
    const targetedDevices = targetsByRule.get(row.ruleName);
    const useAllDevices = !targetedDevices || targetedDevices.length === 0 || targetsAreSerials(targetedDevices);
    if (!useAllDevices && !targetedDevices!.includes(row.deviceName)) continue;

    const hitCount = row.hitCount;
    let lastUsedDate: string | undefined;

    if (hitCount > 0 && row.lastHitTimestamp) {
      const d = parsePanosDate(row.lastHitTimestamp);
      lastUsedDate = d ? d.toISOString() : undefined;
    }
    if (!lastUsedDate && row.ruleModifyTimestamp) {
      const d = parsePanosDate(row.ruleModifyTimestamp);
      lastUsedDate = d ? d.toISOString() : undefined;
    }

    entries.push({
      devicegroup: deviceGroup,
      rulename: row.ruleName,
      lastused: lastUsedDate,
      hitcnt: String(hitCount),
      target: [row.deviceName],
      modificationTimestamp: row.ruleModifyTimestamp || undefined,
    });
  }
  return entries;
}
