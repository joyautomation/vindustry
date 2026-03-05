/**
 * Instrument profile types.
 *
 * A profile captures everything about a real instrument's communication
 * interface: register addresses, data types, scaling, and mappings to
 * physics engine variables.
 */

export type InstrumentProfile = {
  manufacturer: string;
  model: string;
  type: string; // flow-meter, level-transmitter, vfd, valve, etc.
  protocol: "modbus-tcp"; // Extensible: ethernet-ip, opcua, profinet, etc.
  modbus: ModbusProfile;
};

export type ModbusProfile = {
  unitId: number;
  byteOrder: ByteOrder;
  registers: RegisterDefinition[];
};

export type ByteOrder = "ABCD" | "DCBA" | "BADC" | "CDAB";

export type RegisterDefinition = {
  name: string;
  address: number;
  functionCode: "holding" | "input" | "coil" | "discrete";
  datatype: "float32" | "int16" | "uint16" | "int32" | "uint32" | "boolean";
  byteOrder?: ByteOrder; // Override per-register
  scale?: number; // raw_value = engineering_value * scale
  offset?: number; // raw_value = (engineering_value + offset) * scale
  unit?: string;
  writable?: boolean;
  default?: number;
  physics?: string; // Maps to physics engine variable name
  computed?: ComputedType; // Built-in runtime computation
};

export type ComputedType = "accumulate" | "statusWord";

/**
 * The subscribe request sent to tentacle-modbus-server.
 */
export type ModbusSubscribeRequest = {
  deviceId: string;
  port: number;
  unitId: number;
  subscriberId: string;
  sourceModuleId: string;
  tags: {
    variableId: string;
    address: number;
    functionCode: string;
    datatype: string;
    byteOrder?: string;
    writable?: boolean;
  }[];
};

/**
 * Runtime state for computed registers.
 */
export type ComputedState = {
  accumulator: Record<string, number>; // For totalizers
  lastTick: number; // ms timestamp
};
