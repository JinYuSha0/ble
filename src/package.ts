import { Characteristic, UUID } from "react-native-ble-plx";
import { decode } from "base64-arraybuffer";
import { downloadFile } from "~/utils/fs";
import RNGifsicle from "react-native-gifsicle";
import * as FileSystem from "expo-file-system";
import { Buffer } from "buffer";

export enum PackageType {
  Brightness = "Brightness",
  DisplayTime = "DisplayTime",
  HighlightGif = "HighlightGif",
  NotifyAppGif = "NotifyAppGif",
  Reset = "Reset",
}

export interface PackageData {
  mtu?: number;
  type: PackageType;
  data: Uint8Array[];
  write: UUID | ((index: number) => UUID);
}

export const SCAN_SERVICE_UUID: UUID = "00001812-0000-1000-8000-00805f9b34fb";
export const SERVICE_UUID: UUID = "0000a950-0000-1000-8000-00805f9b34fb";
export const WRITE1: UUID = "0000a951-0000-1000-8000-00805f9b34fb";
export const WRITE2: UUID = "0000a952-0000-1000-8000-00805f9b34fb";
export const READ3: UUID = "0000a953-0000-1000-8000-00805f9b34fb";
export const CUSTOM_MTU = 500;

/**
 * 切割Unit8Array
 * @param array
 * @param chunkSize
 * @returns
 */
const splitUint8Array = (
  array: Uint8Array,
  getAppendData?: (chunk: Uint8Array, index: number) => Uint8Array,
  chunkSize: number = CUSTOM_MTU
) => {
  const chunks: Uint8Array[] = [];
  const numChunks = Math.ceil(array.length / chunkSize);

  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkSize;
    const end = start + chunkSize;
    let chunk = array.subarray(start, end);
    if (getAppendData) {
      chunk = new Uint8Array([...getAppendData(chunk, i), ...chunk]);
    }
    chunks.push(chunk);
  }

  return chunks;
};

/**
 * 数字转为字节数组
 * @param value
 * @param byteLength
 * @param littleEndian false 为大端序 高位字节存储在数组的第一个位置
 * @returns
 */
const numberToUint8Array = (
  value: number,
  byteLength: 1 | 2 | 4,
  littleEndian = false
) => {
  // 验证字节长度是否合法
  if (![1, 2, 4].includes(byteLength)) {
    throw new Error("Unsupported byte length. Only 1, 2, and 4 are supported.");
  }

  // 创建一个对应字节长度的 ArrayBuffer
  const buffer = new ArrayBuffer(byteLength);
  // 创建一个 DataView 视图来访问 ArrayBuffer
  const dataView = new DataView(buffer);

  // 根据字节长度写入数字到 DataView
  switch (byteLength) {
    case 1:
      dataView.setUint8(0, value);
      break;
    case 2:
      dataView.setUint16(0, value, littleEndian);
      break;
    case 4:
      dataView.setUint32(0, value, littleEndian);
      break;
    default:
      throw new Error("Unsupported byte length.");
  }

  // 创建一个 Uint8Array 视图来读取字节数据
  return new Uint8Array(buffer);
};

/**
 * 硬件内容签名判断
 */
let CRC_32_TABLE: Uint32Array | null = null;
const calculateCrc32c = (buffer: Uint8Array) => {
  const POLY = 0x82f63b78;
  let crc = 0xffffffff;

  if (!CRC_32_TABLE) {
    CRC_32_TABLE = new Uint32Array(256);
    // 生成 CRC 表
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let j = 8; j > 0; j--) {
        if (value & 1) {
          value = (value >>> 1) ^ POLY;
        } else {
          value >>>= 1;
        }
      }
      CRC_32_TABLE[i] = value;
    }
  }

  // 计算 CRC
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    const tableIndex = (crc ^ byte) & 0xff;
    crc = (CRC_32_TABLE[tableIndex] ^ (crc >>> 8)) >>> 0;
  }

  // 返回 CRC-32-C 值
  return numberToUint8Array((crc ^ 0xffffffff) >>> 0, 4);
};

/**
 * 文件切割
 * @param type Gif类型 0x00表示内置的DIY节目，0x01表示APP的通知节目
 * @param url Gif 下载url
 * @returns
 */
const splicePicFileChunks = async (
  type: 0x00 | 0x01,
  url: string
): Promise<Uint8Array[]> => {
  const { filepath, unlinkFile } = await downloadFile(url);
  const compressedGifUri = await RNGifsicle.compressGif(filepath, {
    lossy: 0,
    colors: 255,
    height: 16,
    width: 16,
  });
  const base64Data = await FileSystem.readAsStringAsync(compressedGifUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const buffer = new Uint8Array(decode(base64Data));
  const crc = calculateCrc32c(buffer);
  const headChunk = new Uint8Array([
    0x4e, // 头码
    0x52, // 头码
    0x0b, // 数据长度
    0x02, // 数据类型
    0x02, // 指令码 1: 表示图片 2：表示gif
    type, // Gif类型 0x00表示内置的DIY节目，0x01表示APP的通知节目
    ...numberToUint8Array(buffer.length, 4), // gif数据总长度 4位
    ...crc, // gif数据检验 4位
    0x00, // 校验码
  ]);
  const bodyChunks = splitUint8Array(
    buffer,
    (chunk, index) =>
      new Uint8Array([
        0x4e, // 头码
        0x52, // 头码
        0x02, //  数据类型 1：图片数据 2：gif数据
        0x01, // 默认0x01
        ...numberToUint8Array(index, 2), // 包下标
        ...numberToUint8Array(chunk.length, 2), // 当前数据包长度 2位
      ])
  );
  const tailChunk = new Uint8Array([
    0x4e, // 头码
    0x52, // 头码
    0x04, // 数据长度，指的是后面的字段数量
    0x81, //  数据类型
    0x01, // 指令
    0x01, // 0x01:发送完所有的分包数据
    0x00, // 校验码
  ]);
  unlinkFile();
  return [headChunk, ...bodyChunks, tailChunk];
};

/**
 * 转base64
 * @param str
 * @returns
 */
const stringToBase64 = (str: string): string => {
  return Buffer.from(str, "utf-8").toString("base64");
};

/**
 * 设置亮度
 * @param value
 * @returns
 */
export const pkg_settingBrightness = (value: number): PackageData => {
  value = Math.min(Math.max(value, 0), 100);
  const chunk = new Uint8Array([
    0x4e, // 头码
    0x52, // 头码
    0x04, // 数据长度
    0x01, // 数据类型
    0x01, // 指令码
    value, // 数据
    0x00, // 校验码
  ]);
  return {
    type: PackageType.Brightness,
    data: [chunk],
    write: WRITE1,
  };
};

/**
 * 设置幕展示时长
 * @param value
 * @returns
 */
export const pkg_settingDisplayTime = (percentage: number): PackageData => {
  percentage = Math.min(Math.max(percentage, 0), 100);
  const ms = Math.trunc(65535 * (percentage / 100));
  const chunk = new Uint8Array([
    0x4e, // 头码
    0x52, // 头码
    0x05, // 数据长度
    0x01, // 数据类型
    0x05, // 指令码
    ...numberToUint8Array(ms, 2), // 2位
    0x00, // 校验码
  ]);
  return {
    type: PackageType.DisplayTime,
    data: [chunk],
    write: WRITE1,
  };
};

/**
 * 设置常亮gif
 * @param url
 */
export const pkg_settingHighlightGif = async (
  url: string
): Promise<PackageData> => {
  const chunks = await splicePicFileChunks(0x00, url);
  return {
    mtu: CUSTOM_MTU,
    type: PackageType.HighlightGif,
    data: chunks,
    write: (index) => {
      // 头、尾包用WRITE1发送 gif数据包用WRITE2发送
      if (index === 0 || index === chunks.length - 1) return WRITE1;
      return WRITE2;
    },
  };
};

/**
 * 设置通知app的gif
 * @param url
 * @param appPackageName
 */
export const pkg_settingNotifyAppGif = async (
  url: string,
  appPackageName: string
): Promise<PackageData> => {
  // 第一步写入包名
  const packageNameBytes = new Uint8Array(
    decode(stringToBase64(appPackageName))
  );
  const step1HeadChunk = new Uint8Array([
    0x4e, // 头码
    0x52, // 头码
    0x05, // 数据长度
    0x02, // 数据类型
    0x0a, // 指令码
    ...numberToUint8Array(packageNameBytes.length, 2), // 包名数据总长度 2位
    0x00, // 校验码
  ]);
  const step1BodyChunks = splitUint8Array(
    packageNameBytes,
    (chunk, index) =>
      new Uint8Array([
        0x4e, // 头码
        0x52, // 头码
        0x0a, // 数据类型 1：图片数据 2：gif数据 3: 0x0A 表示传输包名
        0x01, // 默认0x01
        ...numberToUint8Array(index, 2), // 包下标
        ...numberToUint8Array(chunk.length, 2), // 当前数据包长度 2位
      ])
  );
  const step1TailChunk = new Uint8Array([
    0x4e, // 头码
    0x52, // 头码
    0x04, // 数据长度，指的是后面的字段数量
    0x81, //  数据类型
    0x01, // 指令
    0x01, // 0x01:发送完所有的分包数据
    0x00, // 校验码
  ]);
  const step1Chunks = [step1HeadChunk, ...step1BodyChunks, step1TailChunk];
  // 第二步写入gif
  const step2Chunks = await splicePicFileChunks(0x01, url);
  const chunks = [...step1Chunks, ...step2Chunks];
  return {
    mtu: CUSTOM_MTU,
    type: PackageType.NotifyAppGif,
    data: chunks,
    write: (index) => {
      // 头、尾包用WRITE1发送 数据包用WRITE2发送
      if (
        index === 0 ||
        index === step1Chunks.length - 1 ||
        index === step1Chunks.length ||
        index === chunks.length - 1
      ) {
        return WRITE1;
      }
      return WRITE2;
    },
  };
};

/**
 * 重置设备
 * @param url
 */
export const pkg_reset = (): PackageData => {
  const chunk = new Uint8Array([
    0x4e, // 头码
    0x52, // 头码
    0x04, // 数据长度
    0x01, // 数据类型
    0x0c, // 指令码
    0x01, // 数据
    0x00, // 校验码
  ]);
  return {
    type: PackageType.Reset,
    data: [chunk],
    write: WRITE1,
  };
};

/**
 * response 前置检查
 * @param value
 * @returns
 */
const response_prev_check = (value: string | undefined | null) => {
  if (!value) throw new Error("The response is empty");
  const buffer = decode(value);
  if (buffer instanceof ArrayBuffer) {
    const unit8Arr = new Uint8Array(buffer);
    if (unit8Arr[0] === 0x4e && unit8Arr[1] === 0x52) {
      return unit8Arr;
    }
  }
  throw new Error("The response is incorrect");
};

const COMMON_RESPONSE_CHECK = (characteristic: Characteristic | null) => {
  try {
    const data = response_prev_check(characteristic?.value);
    return (
      (data[2] === 0x04 && data[5] === 0x01) ||
      (data[2] === 0x06 && data[7] === 0x01)
    );
  } catch (err) {}
  return false;
};

/**
 * 检查返回response是否正确
 */
export const RESPONSE_CHECK: Partial<
  Record<PackageType, (characteristic: Characteristic | null) => boolean>
> = {
  [PackageType.DisplayTime]: COMMON_RESPONSE_CHECK,
  [PackageType.HighlightGif]: COMMON_RESPONSE_CHECK,
  [PackageType.NotifyAppGif]: COMMON_RESPONSE_CHECK,
  [PackageType.Reset]: COMMON_RESPONSE_CHECK,
};
