import type { DeviceId, Subscription } from "react-native-ble-plx";
import {
  PackageData,
  PackageType,
  READ3,
  RESPONSE_CHECK,
  SERVICE_UUID,
} from "./package";
import type { BleService } from "./ble";
import { decode, encode } from "base64-arraybuffer";
import { deferred } from "./common";
import { isNil } from "lodash";

class Task {
  public id: number;

  public type: PackageType;

  public deviceId: DeviceId;

  public packageData: PackageData;

  public chunksIndex: number = 0;

  public promise: Promise<Task>;

  private retry: number = 0;

  private timerId: number | null = null;

  private deferred: ReturnType<typeof deferred<Task>>;

  private characteristicMonitor: Subscription | null = null;

  constructor(deviceId: DeviceId, packageData: PackageData) {
    this.id = +new Date();
    this.type = packageData.type;
    this.deviceId = deviceId;
    this.packageData = packageData;
    this.deferred = deferred<Task>();
    this.promise = this.deferred.promise;
  }

  public get BleServiceInstance(): BleService {
    // 解决 Require cycle 问题
    return require("./ble").BleServiceInstance;
  }

  public getDevice() {
    const decvice = this.BleServiceInstance.getConnectingDevice(this.deviceId);
    if (!decvice) {
      throw new Error("Device is not connected");
    }
    return decvice;
  }

  public hasNextChunk() {
    return this.chunksIndex < this.packageData.data.length;
  }

  private async next(isMonitor: boolean = false) {
    try {
      const device = this.getDevice();
      if (!device) throw new Error("Device no connection");
      const currentChunksIndex = this.chunksIndex;
      // 在发送第一个包前，请求更大的 MTU（最大传输单元）值。MTU 决定了通过蓝牙传输的数据包的最大大小。
      if (currentChunksIndex === 0 && this.packageData.mtu) {
        await device.requestMTU(this.packageData.mtu);
      }
      const chunk = this.packageData.data[currentChunksIndex];
      this.chunksIndex += 1;
      const write =
        typeof this.packageData.write === "function"
          ? this.packageData.write(currentChunksIndex)
          : this.packageData.write;
      console.log("发送包===>", this.packageData.type, chunk, write);
      await device.writeCharacteristicWithoutResponseForService(
        SERVICE_UUID,
        write,
        encode(chunk)
      );
      if (isMonitor) {
        // 超时重传机制
        this.monitorTimeout(currentChunksIndex);
      }
      const hasNextChunk = this.hasNextChunk();
      // 所有包发送完成且没有中途报则错判断为任务成功
      if (!hasNextChunk && !isMonitor) {
        this.resolve();
      }
      return hasNextChunk;
    } catch (err) {
      // 中途有报错判断为任务失败
      this.reject(err as Error);
      throw err;
    }
  }

  public resolve() {
    if (this.characteristicMonitor) this.characteristicMonitor.remove();
    this.deferred.resolve(this);
  }

  public reject(error: Error) {
    if (this.characteristicMonitor) this.characteristicMonitor.remove();
    this.deferred.reject(error);
  }

  public async nextWhileTrue() {
    while (await this.next()) {}
  }

  private monitorTimeout(chunkIndex: number, ms: number = 2 * 1000) {
    // APP 在传输的时候，得考虑超时，每个包发送后如果 1s 都没有收到回复，说明传输超时，需要重新传输（重新开始传输），如果重传超过 3 次，都传输失败，表示该次设置数据失败。
    this.timerId = setTimeout(() => {
      if (this.retry >= 2) {
        this.reject(new Error("Timeout, too many retries"));
      } else {
        this.chunksIndex = chunkIndex;
        this.retry += 1;
        this.next(true);
      }
    }, ms);
  }

  private cancelMonitorTimeout() {
    if (!isNil(this.timerId)) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  public nextWithMonitor() {
    if (this.characteristicMonitor) {
      this.characteristicMonitor.remove();
    }
    this.characteristicMonitor =
      this.getDevice().monitorCharacteristicForService(
        SERVICE_UUID,
        READ3,
        async (err, characteristic) => {
          try {
            this.cancelMonitorTimeout();
            if (err) {
              this.reject(err);
              return;
            }
            if (__DEV__ && characteristic?.value) {
              console.log(
                "接受包===>",
                this.packageData.type,
                new Uint8Array(decode(characteristic?.value))
              );
            }
            // 检查返回特征是否成功
            if (!(RESPONSE_CHECK[this.type]?.(characteristic) ?? true)) {
              this.reject(new Error("Response verification failed"));
              return;
            }
            const hasNextChunk = this.hasNextChunk();
            if (hasNextChunk) {
              await this.next(true);
            } else {
              this.resolve();
            }
          } catch (ignore) {}
        }
      );
    // 自动发首包
    this.next(true);
  }
}

class TaskPool {
  private taskMap: Map<string, Set<Task>>;

  private taskLock: Map<number, ReturnType<typeof deferred<void>>>;

  constructor() {
    this.taskMap = new Map();
    this.taskLock = new Map();
  }

  public async createTask(deviceId: DeviceId, packageData: PackageData) {
    const task = new Task(deviceId, packageData);
    const lock = deferred<void>();
    // 创建锁
    this.taskLock.set(task.id, lock);
    // 将任务放入队列
    if (!this.taskMap.has(deviceId)) {
      this.taskMap.set(deviceId, new Set());
    }
    const queue = this.taskMap.get(deviceId)!;
    queue.add(task);
    // 无任务默认执行第一个任务
    if (queue.size === 1) {
      this.next(deviceId);
    }
    // 只有队列执行到此任务时才返回task
    await lock.promise;
    // 移除此任务
    task.promise
      .then(() => {
        queue.delete(task);
      })
      .catch(() => {
        queue.delete(task);
      });
    return task;
  }

  public async next(deviceId: DeviceId) {
    const currentTask = Array.from(this.taskMap.get(deviceId) ?? [])[0];
    if (!currentTask) return;
    // 解开任务锁
    if (this.taskLock.has(currentTask.id)) {
      const deferred = this.taskLock.get(currentTask.id);
      deferred?.resolve();
      this.taskLock.delete(currentTask.id);
    }
    // 当前任务结束后执行下一个任务
    try {
      await currentTask.promise;
    } finally {
      this.next(deviceId);
    }
  }

  public clearTask() {
    this.taskMap.clear();
  }

  public clearTaskByDeviceId(deviceId: DeviceId) {
    this.taskMap.delete(deviceId);
  }
}

const TaskPoolInstance = new TaskPool();

export default TaskPoolInstance;
