import { loadConfig } from '../server/lib/config.mjs';

// Probe processes use their own temporary roots/state. Only this optional WSL
// identity is read from the operator's private configuration.
export async function smokeWslOptions(values = {}, required = false) {
  const distro = values['wsl-distro'];
  const user = values['wsl-user'];
  if (Boolean(distro) !== Boolean(user)) throw new Error('Pass both --wsl-distro and --wsl-user, or use the configured WSL integration.');
  if (distro && user) return { enabled: true, distro, user };
  if (!required) return { enabled: false };
  const configured = (await loadConfig()).wsl;
  if (configured?.enabled === false || !configured?.distro || !configured?.user) {
    throw new Error('WSL is not configured. Enable it in the private agent config or pass --wsl-distro and --wsl-user.');
  }
  return { ...configured, enabled: true };
}

export function temporaryWslPath(windowsPath) {
  if (!/^[A-Za-z]:[\\/]/.test(windowsPath)) throw new Error('This probe requires a local Windows temporary directory mounted under /mnt in WSL.');
  return `/mnt/${windowsPath[0].toLowerCase()}${windowsPath.slice(2).replaceAll('\\', '/')}`;
}
