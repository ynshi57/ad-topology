/**
 * Protobuf decoder for mcap messages.
 *
 * Strategy: protobufjs in Vite/ESM has compatibility issues with the descriptor extension.
 * Instead, we use protobufjs's JSON descriptor approach:
 * 1. Parse FileDescriptorSet manually using a minimal protobuf definition
 * 2. Convert to protobufjs JSON format
 * 3. Build Root from JSON
 */

const schemaCache = new Map();
let protobufModule = null;
let fdsDecoder = null;

async function getProtobuf() {
  if (protobufModule) return protobufModule;
  const mod = await import('protobufjs/dist/protobuf.js');
  protobufModule = mod.default || mod;
  return protobufModule;
}

/**
 * Build a minimal FDS decoder from protobufjs.
 * We define just enough of descriptor.proto to decode FileDescriptorSet.
 */
async function getFdsDecoder() {
  if (fdsDecoder) return fdsDecoder;
  const protobuf = await getProtobuf();

  const descriptorJson = {
    nested: {
      google: { nested: { protobuf: { nested: {
        FileDescriptorSet: { fields: { file: { rule: "repeated", type: "FileDescriptorProto", id: 1 } } },
        FileDescriptorProto: { fields: {
          name: { type: "string", id: 1 },
          package: { type: "string", id: 2 },
          dependency: { rule: "repeated", type: "string", id: 3 },
          messageType: { rule: "repeated", type: "DescriptorProto", id: 4 },
          enumType: { rule: "repeated", type: "EnumDescriptorProto", id: 5 },
          syntax: { type: "string", id: 12 },
        }},
        DescriptorProto: { fields: {
          name: { type: "string", id: 1 },
          field: { rule: "repeated", type: "FieldDescriptorProto", id: 2 },
          nestedType: { rule: "repeated", type: "DescriptorProto", id: 3 },
          enumType: { rule: "repeated", type: "EnumDescriptorProto", id: 4 },
          oneofDecl: { rule: "repeated", type: "OneofDescriptorProto", id: 8 },
        }},
        FieldDescriptorProto: { fields: {
          name: { type: "string", id: 1 },
          number: { type: "int32", id: 3 },
          label: { type: "FieldDescriptorProto.Label", id: 4 },
          type: { type: "FieldDescriptorProto.Type", id: 5 },
          typeName: { type: "string", id: 6 },
          defaultValue: { type: "string", id: 7 },
          oneofIndex: { type: "int32", id: 9 },
          jsonName: { type: "string", id: 10 },
        }, nested: {
          Label: { values: { LABEL_OPTIONAL: 1, LABEL_REQUIRED: 2, LABEL_REPEATED: 3 } },
          Type: { values: {
            TYPE_DOUBLE: 1, TYPE_FLOAT: 2, TYPE_INT64: 3, TYPE_UINT64: 4,
            TYPE_INT32: 5, TYPE_FIXED64: 6, TYPE_FIXED32: 7, TYPE_BOOL: 8,
            TYPE_STRING: 9, TYPE_GROUP: 10, TYPE_MESSAGE: 11, TYPE_BYTES: 12,
            TYPE_UINT32: 13, TYPE_ENUM: 14, TYPE_SFIXED32: 15, TYPE_SFIXED64: 16,
            TYPE_SINT32: 17, TYPE_SINT64: 18,
          }},
        }},
        EnumDescriptorProto: { fields: {
          name: { type: "string", id: 1 },
          value: { rule: "repeated", type: "EnumValueDescriptorProto", id: 2 },
        }},
        EnumValueDescriptorProto: { fields: {
          name: { type: "string", id: 1 },
          number: { type: "int32", id: 2 },
        }},
        OneofDescriptorProto: { fields: {
          name: { type: "string", id: 1 },
        }},
      }}}}
    }
  };

  const root = protobuf.Root.fromJSON(descriptorJson);
  fdsDecoder = root.lookupType('google.protobuf.FileDescriptorSet');
  return fdsDecoder;
}

const TYPE_MAP = {
  1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32',
  6: 'fixed64', 7: 'fixed32', 8: 'bool', 9: 'string', 12: 'bytes',
  13: 'uint32', 14: 'int32', 15: 'sfixed32', 16: 'sfixed64',
  17: 'sint32', 18: 'sint64',
};

function descriptorToJson(fdsObj) {
  const json = { nested: {} };

  for (const file of fdsObj.file || []) {
    const pkg = file.package || '';
    let target = json.nested;

    if (pkg) {
      for (const part of pkg.split('.')) {
        if (!target[part]) target[part] = { nested: {} };
        target = target[part].nested;
      }
    }

    for (const msg of file.messageType || []) {
      convertMessage(msg, target);
    }
    for (const en of file.enumType || []) {
      convertEnum(en, target);
    }
  }
  return json;
}

function convertMessage(desc, parent) {
  const msg = { fields: {} };
  for (const f of desc.field || []) {
    const field = { type: resolveType(f.type, f.typeName), id: f.number };
    if (f.label === 3 || f.label === 'LABEL_REPEATED') field.rule = 'repeated';
    if (f.oneofIndex !== undefined && f.oneofIndex !== null) field.oneofIndex = f.oneofIndex;
    msg.fields[f.jsonName || f.name] = field;
  }
  if (desc.oneofDecl?.length) {
    msg.oneofs = {};
    desc.oneofDecl.forEach((od, i) => {
      const fieldNames = (desc.field || []).filter(f => f.oneofIndex === i).map(f => f.jsonName || f.name);
      if (fieldNames.length) msg.oneofs[od.name] = { oneof: fieldNames };
    });
  }
  if (desc.nestedType?.length || desc.enumType?.length) {
    msg.nested = {};
    for (const nested of desc.nestedType || []) convertMessage(nested, msg.nested);
    for (const en of desc.enumType || []) convertEnum(en, msg.nested);
  }
  parent[desc.name] = msg;
}

function convertEnum(desc, parent) {
  const values = {};
  for (const v of desc.value || []) values[v.name] = v.number;
  parent[desc.name] = { values };
}

function resolveType(typeNum, typeName) {
  if (typeNum === 11 || typeNum === 14 || typeNum === 'TYPE_MESSAGE' || typeNum === 'TYPE_ENUM') {
    return typeName?.replace(/^\./, '') || 'unknown';
  }
  return TYPE_MAP[typeNum] || TYPE_MAP[Number(typeNum)] || 'bytes';
}

/**
 * Initialize decoder from mcap readers.
 */
export async function initDecoder(readers) {
  const protobuf = await getProtobuf();
  const FDS = await getFdsDecoder();

  for (const { reader } of readers) {
    for (const [schemaId, schema] of reader.schemasById) {
      if (schemaCache.has(schemaId)) continue;
      if (schema.encoding !== 'protobuf' || !schema.data || schema.data.byteLength === 0) continue;

      try {
        const data = schema.data instanceof Uint8Array ? schema.data : new Uint8Array(schema.data);
        const fdsObj = FDS.decode(data);
        const fdsPlain = FDS.toObject(fdsObj, { longs: Number, enums: Number, defaults: false });
        const jsonDef = descriptorToJson(fdsPlain);
        const root = protobuf.Root.fromJSON(jsonDef);
        root.resolveAll();
        const msgType = root.lookupType(schema.name);
        schemaCache.set(schemaId, { root, messageType: msgType, name: schema.name });
      } catch (e) {
        console.warn(`Schema ${schemaId} (${schema.name}): ${e.message}`);
      }
    }
  }

  let total = 0;
  for (const { reader } of readers) total += reader.schemasById.size;
  console.log(`Proto decoder: ${schemaCache.size} / ${total} schemas loaded`);
}

export function decodeMessage(schemaId, data) {
  const cached = schemaCache.get(schemaId);
  if (!cached) return null;
  try {
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    const msg = cached.messageType.decode(input);
    return cached.messageType.toObject(msg, {
      longs: Number, enums: String, bytes: String, defaults: false,
    });
  } catch {
    return null;
  }
}

// Like decodeMessage, but keeps 64-bit integers as decimal strings so large
// fault codes (> 2^53) survive without precision loss.
export function decodeMessageStrings(schemaId, data) {
  const cached = schemaCache.get(schemaId);
  if (!cached) return null;
  try {
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    const msg = cached.messageType.decode(input);
    return cached.messageType.toObject(msg, {
      longs: String, enums: String, bytes: String, defaults: false,
    });
  } catch {
    return null;
  }
}

export function decodeMessageByType(typeName, data) {
  const cached = [...schemaCache.values()].find(s => s.name === typeName);
  if (!cached) return null;
  try {
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    const msg = cached.messageType.decode(input);
    return cached.messageType.toObject(msg, {
      longs: Number, enums: String, bytes: String, defaults: false,
    });
  } catch {
    return null;
  }
}

export function getSchemaName(schemaId) {
  return schemaCache.get(schemaId)?.name || 'unknown';
}

export function canDecode(schemaId) {
  return schemaCache.has(schemaId);
}
