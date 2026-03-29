export const DEVICE_TYPES = [
  "printer",
  "handheld_reader",
  "fixed_reader",
  "transaction_reader",
  "door_reader",
  "antenna",
] as const;

export type DeviceType = (typeof DEVICE_TYPES)[number];

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  printer: "Printers",
  handheld_reader: "Hand-held readers",
  fixed_reader: "Fixed readers",
  transaction_reader: "Transaction readers",
  door_reader: "Door readers",
  antenna: "Antennas",
};
