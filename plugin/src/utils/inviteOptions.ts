export function parseInviteMaxDevices(value: string | undefined): number | null {
  const raw = (value || "1").trim();
  const maxDevices = raw ? Number(raw) : 1;
  return Number.isInteger(maxDevices) && maxDevices >= 1 && maxDevices <= 10 ? maxDevices : null;
}

export function inviteDeviceLabel(maxDevices: number | undefined): string {
  const count = Number.isInteger(maxDevices) && (maxDevices || 0) > 0 ? maxDevices! : 1;
  return `${count} device${count === 1 ? "" : "s"}`;
}
