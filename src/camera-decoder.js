/**
 * Camera-specific protobuf decoder.
 *
 * Unlike the generic proto-decoder (which converts bytes to base64 strings),
 * this module keeps image data as raw Uint8Array to avoid base64 overhead
 * when creating Blob URLs for rendering.
 */

let protobufModule = null;
const decoderCache = new Map(); // schemaId -> { messageType }

async function getProtobuf() {
  if (protobufModule) {
    return protobufModule;
  }
  const mod = await import('protobufjs/dist/protobuf.js');
  protobufModule = mod.default || mod;
  return protobufModule;
}

/**
 * Build a decoder from raw FileDescriptorSet bytes for a given schema name.
 */
async function buildDecoder(schemaData, schemaName) {
  const protobuf = await getProtobuf();

  const descriptorJson = {
    nested: {
      google: { nested: { protobuf: { nested: {
        FileDescriptorSet: { fields: { file: { rule: 'repeated', type: 'FileDescriptorProto', id: 1 } } },
        FileDescriptorProto: { fields: {
          name: { type: 'string', id: 1 },
          package: { type: 'string', id: 2 },
          dependency: { rule: 'repeated', type: 'string', id: 3 },
          messageType: { rule: 'repeated', type: 'DescriptorProto', id: 4 },
          enumType: { rule: 'repeated', type: 'EnumDescriptorProto', id: 5 },
          syntax: { type: 'string', id: 12 },
        } },
        DescriptorProto: { fields: {
          name: { type: 'string', id: 1 },
          field: { rule: 'repeated', type: 'FieldDescriptorProto', id: 2 },
          nestedType: { rule: 'repeated', type: 'DescriptorProto', id: 3 },
          enumType: { rule: 'repeated', type: 'EnumDescriptorProto', id: 4 },
          oneofDecl: { rule: 'repeated', type: 'OneofDescriptorProto', id: 8 },
        } },
        FieldDescriptorProto: { fields: {
          name: { type: 'string', id: 1 },
          number: { type: 'int32', id: 3 },
          label: { type: 'FieldDescriptorProto.Label', id: 4 },
          type: { type: 'FieldDescriptorProto.Type', id: 5 },
          typeName: { type: 'string', id: 6 },
          defaultValue: { type: 'string', id: 7 },
          oneofIndex: { type: 'int32', id: 9 },
          jsonName: { type: 'string', id: 10 },
        }, nested: {
          Label: { values: { LABEL_OPTIONAL: 1, LABEL_REQUIRED: 2, LABEL_REPEATED: 3 } },
          Type: { values: {
            TYPE_DOUBLE: 1, TYPE_FLOAT: 2, TYPE_INT64: 3, TYPE_UINT64: 4,
            TYPE_INT32: 5, TYPE_FIXED64: 6, TYPE_FIXED32: 7, TYPE_BOOL: 8,
            TYPE_STRING: 9, TYPE_GROUP: 10, TYPE_MESSAGE: 11, TYPE_BYTES: 12,
            TYPE_UINT32: 13, TYPE_ENUM: 14, TYPE_SFIXED32: 15, TYPE_SFIXED64: 16,
            TYPE_SINT32: 17, TYPE_SINT64: 18,
          } },
        } },
        EnumDescriptorProto: { fields: {
          name: { type: 'string', id: 1 },
          value: { rule: 'repeated', type: 'EnumValueDescriptorProto', id: 2 },
        } },
        EnumValueDescriptorProto: { fields: {
          name: { type: 'string', id: 1 },
          number: { type: 'int32', id: 2 },
        } },
        OneofDescriptorProto: { fields: {
          name: { type: 'string', id: 1 },
        } },
      } } } }
    }
  };

  const fdsRoot = protobuf.Root.fromJSON(descriptorJson);
  const FDS = fdsRoot.lookupType('google.protobuf.FileDescriptorSet');

  const TYPE_MAP = {
    1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32',
    6: 'fixed64', 7: 'fixed32', 8: 'bool', 9: 'string', 12: 'bytes',
    13: 'uint32', 14: 'int32', 15: 'sfixed32', 16: 'sfixed64',
    17: 'sint32', 18: 'sint64',
  };

  function resolveType(typeNum, typeName) {
    if (typeNum === 11 || typeNum === 14) {
      return typeName?.replace(/^\./, '') || 'unknown';
    }
    return TYPE_MAP[typeNum] || 'bytes';
  }

  function convertMsg(desc, parent) {
    const m = { fields: {} };
    for (const f of desc.field || []) {
      const field = { type: resolveType(f.type, f.typeName), id: f.number };
      if (f.label === 3) { field.rule = 'repeated'; }
      m.fields[f.jsonName || f.name] = field;
    }
    if (desc.nestedType?.length) {
      m.nested = {};
      for (const nested of desc.nestedType) { convertMsg(nested, m.nested); }
    }
    parent[desc.name] = m;
  }

  const data = schemaData instanceof Uint8Array ? schemaData : new Uint8Array(schemaData);
  const fdsObj = FDS.decode(data);
  const fdsPlain = FDS.toObject(fdsObj, { longs: Number, enums: Number, defaults: false });

  const json = { nested: {} };
  for (const file of fdsPlain.file || []) {
    const pkg = file.package || '';
    let target = json.nested;
    if (pkg) {
      for (const part of pkg.split('.')) {
        if (!target[part]) { target[part] = { nested: {} }; }
        target = target[part].nested;
      }
    }
    for (const msg of file.messageType || []) {
      convertMsg(msg, target);
    }
  }

  const root = protobuf.Root.fromJSON(json);
  root.resolveAll();
  return root.lookupType(schemaName);
}

/**
 * Initialize camera decoders from mcap readers.
 * Call once after loadMcapFiles. Registers decoders for CompressedImage,
 * CameraCalibration, and FrameTransform schemas.
 */
const CAMERA_SCHEMAS = new Set([
  'foxglove.CompressedImage',
  'foxglove.CameraCalibration',
  'foxglove.FrameTransform',
]);

export async function initCameraDecoders(readers) {
  for (const { reader } of readers) {
    for (const [schemaId, schema] of reader.schemasById) {
      if (decoderCache.has(schemaId)) { continue; }
      if (schema.encoding !== 'protobuf' || !schema.data?.byteLength) { continue; }
      if (!CAMERA_SCHEMAS.has(schema.name)) { continue; }

      try {
        const msgType = await buildDecoder(schema.data, schema.name);
        decoderCache.set(schemaId, { messageType: msgType, name: schema.name });
      } catch (e) {
        console.warn(`Camera schema ${schemaId} (${schema.name}): ${e.message}`);
      }
    }
  }
  console.log(`Camera decoder: ${decoderCache.size} schemas loaded`);
}

/**
 * Decode a foxglove.CompressedImage message, keeping `data` as Uint8Array.
 * Returns { format, data, frameId, timestamp } or null.
 */
export function decodeCameraFrame(schemaId, rawData) {
  const cached = decoderCache.get(schemaId);
  if (!cached || cached.name !== 'foxglove.CompressedImage') { return null; }

  try {
    const input = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
    const msg = cached.messageType.decode(input);
    const obj = cached.messageType.toObject(msg, {
      longs: Number,
      enums: String,
      bytes: Uint8Array,
      defaults: false,
    });
    return {
      format: obj.format || '',
      data: obj.data instanceof Uint8Array ? obj.data : new Uint8Array(0),
      frameId: obj.frameId || '',
      timestamp: obj.timestamp || null,
    };
  } catch {
    return null;
  }
}

/**
 * Decode a foxglove.CameraCalibration message.
 * Returns parsed intrinsics or null.
 */
export function decodeCameraCalibration(schemaId, rawData) {
  const cached = decoderCache.get(schemaId);
  if (!cached || cached.name !== 'foxglove.CameraCalibration') { return null; }

  try {
    const input = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
    const msg = cached.messageType.decode(input);
    const obj = cached.messageType.toObject(msg, {
      longs: Number, enums: String, bytes: String, defaults: false,
    });
    return {
      frameId: obj.frameId || '',
      width: obj.width || 0,
      height: obj.height || 0,
      distortionModel: obj.distortionModel || '',
      D: obj.D || [],
      K: obj.K || [],
      R: obj.R || [],
      P: obj.P || [],
      timestamp: obj.timestamp || null,
    };
  } catch {
    return null;
  }
}

/**
 * Decode a foxglove.FrameTransform message.
 * Returns parsed transform or null.
 */
export function decodeFrameTransform(schemaId, rawData) {
  const cached = decoderCache.get(schemaId);
  if (!cached || cached.name !== 'foxglove.FrameTransform') { return null; }

  try {
    const input = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
    const msg = cached.messageType.decode(input);
    const obj = cached.messageType.toObject(msg, {
      longs: Number, enums: String, bytes: String, defaults: false,
    });
    return {
      parentFrameId: obj.parentFrameId || '',
      childFrameId: obj.childFrameId || '',
      timestamp: obj.timestamp || null,
      translation: obj.translation || null,
      rotation: obj.rotation || null,
    };
  } catch {
    return null;
  }
}

export function isCameraSchema(schemaName) {
  return CAMERA_SCHEMAS.has(schemaName);
}
