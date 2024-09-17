import { Buffer } from "buffer";
import { t } from "i18next";
import { PermissionsAndroid, Platform } from "react-native";
import {
  BleManager,
  Device,
  State as BluetoothState,
  BleError,
  BleErrorCode,
  LogLevel,
  UUID,
  DeviceId,
  Subscription,
} from "react-native-ble-plx";
import EventEmitter from "react-native/Libraries/vendor/emitter/EventEmitter";
import TaskPoolInstance from "./task";
import {
  pkg_settingBrightness,
  pkg_settingDisplayTime,
  pkg_settingHighlightGif,
  pkg_settingNotifyAppGif,
  pkg_reset,
  SERVICE_UUID,
  SCAN_SERVICE_UUID,
} from "./package";
import useDeviceStore from "~/src/state/device";

const SERVICE_UUIDS: UUID[] = [SERVICE_UUID, SCAN_SERVICE_UUID];

export class BleServiceError extends Error {
  state: BluetoothState;

  constructor(
    message?: string,
    state: BluetoothState = BluetoothState.Unknown
  ) {
    super(message);
    this.state = state;
  }
}

export enum BleServiceEvent {
  STATE_CHANGE = "STATE_CHANGE",
  DEVICE_CHANGE = "DEVICE_CHANGE",
  CONNECTED_DEVICE_CHANGE = "CONNECTED_DEVICE_CHANGE",
  FOUNDED_DEVICE_CHANGE = "FOUNDED_DEVICE_CHANGE",
}

type SortDevice = Device & { ts: number };

export class BleService extends EventEmitter {
  private readonly logLevel: LogLevel = LogLevel.None;

  private manager!: BleManager;

  private state: BluetoothState;

  // 正在使用的设备
  private currentDevice: Device | null = null;

  // 正在连接的设备
  private connectingDevices: Map<string, SortDevice> = new Map();

  // 扫描出来的设备
  private foundDevices: Map<string, Device> = new Map();

  // 以前连接过的设备
  private connectedDevices: Map<string, Device> = new Map();

  private scanning = false;

  private stateMointerSubscription: Subscription | undefined;

  constructor() {
    super();
    this.state = BluetoothState.Unknown;
    this.createNewManager();
  }

  public getState = () => this.state;

  public getCurrentDevice = () => this.currentDevice;

  public getConnectingDevices = () =>
    Array.from(this.connectingDevices.values());

  public getConnectingDevice = (deviceId: DeviceId) =>
    this.connectingDevices.get(deviceId);

  public getFoundDevices = () => Array.from(this.foundDevices.values());

  public getConnectedDevices = () => Array.from(this.connectedDevices.values());

  public async createNewManager() {
    if (this.manager) {
      this.manager.destroy();
    }
    this.manager = new BleManager();
    this.manager.setLogLevel(this.logLevel);
    this.refreshConnectedDevice();
    this.monitorState();
  }

  /**
   * 初始化 获取manager状态
   * @returns
   */
  public initialize = () =>
    new Promise<void>((resolve, reject) => {
      const subscription = this.manager.onStateChange((state) => {
        this.onBluetoothStateChange(state);
        switch (state) {
          case BluetoothState.Unsupported:
            reject(new BleServiceError("Unsupported", state));
            subscription.remove();
            break;
          case BluetoothState.PoweredOff:
            if (Platform.OS === "android") {
              // 只有android支持打开蓝牙
              this.manager.enable().catch((error: BleError) => {
                if (error.errorCode === BleErrorCode.BluetoothUnauthorized) {
                  this.requestBluetoothPermission();
                }
              });
            } else if (Platform.OS === "ios") {
              // ios只能提示用户打开蓝牙
              reject(new BleServiceError("PoweredOff", state));
              subscription.remove();
            }
            break;
          case BluetoothState.Unauthorized:
            this.requestBluetoothPermission();
            break;
          case BluetoothState.PoweredOn:
            resolve();
            subscription.remove();
            break;
          case BluetoothState.Resetting:
            break;
          default:
            reject(new BleServiceError("Unknow state"));
            break;
        }
      }, true);
    });

  /**
   * 监控状态
   */
  public monitorState() {
    if (this.stateMointerSubscription) {
      this.stateMointerSubscription.remove();
    }
    this.stateMointerSubscription = this.manager.onStateChange((state) => {
      switch (state) {
        case BluetoothState.PoweredOn:
          this.refreshConnectedDevice();
          break;
      }
    }, false);
  }

  /**
   * 刷新已经连接过的设备，用户有可能在启动app前手动蓝牙连接设备
   */
  public async refreshConnectedDevice(clear: boolean = true) {
    await this.initialize();
    // const historyConnectedDevices = useDeviceStore
    //   .getState()
    //   .connectedDevices.map((device) => device.id);
    const currentConnectDevices = (
      await this.manager.connectedDevices(SERVICE_UUIDS)
    ).map((device) => device.id);
    const connectedDevices = [...new Set([...currentConnectDevices])];
    try {
      if (connectedDevices && connectedDevices.length) {
        if (clear) this.connectedDevices.clear();
        await this.initialize();
        const devices = await this.manager.devices([...connectedDevices]);
        devices.forEach((device) => {
          this.connectedDevices.set(device.id, device);
          this.connectToDevice(device.id);
        });
        this.onConnectedDeviceChange(null);
      }
    } catch (err) {
      this.onError(err);
    }
  }

  /**
   * 检查设备是否连接
   */
  public async prevCheckDevice() {
    await this.initialize();
    if (!this.currentDevice) {
      throw new Error("Device is not connected");
    }
    if ((await this.currentDevice.isConnected()) !== true) {
      await this.connectToDevice(this.currentDevice.id);
    }
  }

  /**
   * 手动设置正在使用的设备
   * @param device
   */
  public async setCurrentDevice(deviceId: DeviceId) {
    if (this.currentDevice?.id === deviceId) return;
    const device = this.connectingDevices.get(deviceId);
    if (!device) {
      throw new Error("Device is not connected");
    }
    if (await device.isConnected()) {
      this.currentDevice = device;
      this.onDeviceChange(null);
    }
  }

  /**
   * 开始扫描设备
   * @param clear
   * @param onFoundNewDevice
   * @returns
   */
  public scanDevices = async (
    clear: boolean = false,
    onFoundNewDevice?: (newDevice: Device) => void
  ) => {
    await this.initialize();
    this.refreshConnectedDevice();
    if (this.scanning) {
      this.stopDeviceScan();
    }
    this.scanning = true;
    if (clear) {
      // 清除之前发现的设备
      this.onFoundedDeviceClear();
    }
    this.manager.startDeviceScan(SERVICE_UUIDS, null, (error, device) => {
      if (error) {
        this.onError(error);
        this.stopDeviceScan();
        return;
      }
      if (
        device &&
        device.id &&
        device.name &&
        !this.foundDevices.has(device.id)
      ) {
        onFoundNewDevice?.(device);
        this.onFoundedDeviceChange(device);
      }
    });
  };

  /**
   * 停止扫描设备
   */
  public stopDeviceScan() {
    this.scanning = false;
    this.manager.stopDeviceScan();
  }

  /**
   * 连接指定设备
   * @param device
   */
  public async connectToDevice(deviceId: DeviceId) {
    await this.initialize();
    this.stopDeviceScan();
    let deviceConnection: Device | undefined;
    try {
      deviceConnection = await this.manager.connectToDevice(deviceId);
    } catch (err) {
      if (err instanceof BleError) {
        if (err.errorCode === BleErrorCode.DeviceAlreadyConnected) {
          // 设备正在连接中的情况
          const [alreadyConnectedDevice] = await this.manager.devices([
            deviceId,
          ]);
          if (
            alreadyConnectedDevice &&
            (await alreadyConnectedDevice.isConnected())
          ) {
            await this.onConnecting(alreadyConnectedDevice);
            return alreadyConnectedDevice;
          }
        }
      }
      // 连接报错
      this.onDeviceChange(null);
      err instanceof Error && this.onError(err);
      throw err;
    }
    if (!deviceConnection) throw new BleServiceError("Can not get device");
    await this.onConnecting(deviceConnection);
    return deviceConnection;
  }

  /**
   * 设备连接后处理
   * @param device
   */
  public async onConnecting(device: Device) {
    await device.discoverAllServicesAndCharacteristics();
    this.onDeviceChange(device);
    const subscription = device.onDisconnected((error, device) => {
      // 设备断开连接
      if (error) {
        this.onError(error);
      }
      this.connectingDevices.delete(device.id);
      TaskPoolInstance.clearTaskByDeviceId(device.id);
      this.onDeviceChange(null);
      subscription.remove();
    });
  }

  /**
   * 断开设备连接
   * @param deviceId
   * @returns
   */
  public async disconnectDevice(deviceId: DeviceId) {
    try {
      await this.manager.cancelDeviceConnection(deviceId);
      this.connectingDevices.delete(deviceId);
      TaskPoolInstance.clearTaskByDeviceId(deviceId);
      this.onDeviceChange(null);
      return true;
    } catch (error) {
      if (error instanceof BleError) {
        if (error.errorCode === BleErrorCode.DeviceDisconnected) {
          this.connectingDevices.delete(deviceId);
          TaskPoolInstance.clearTaskByDeviceId(deviceId);
          this.onDeviceChange(null);
          return true;
        }
      }
      this.onError(error);
    }
    return false;
  }

  /**
   * 设置高亮gif
   */
  public async settingHighlightGif(url: string) {
    await this.prevCheckDevice();
    const packageData = await pkg_settingHighlightGif(url);
    // 创建任务
    const task = await TaskPoolInstance.createTask(
      this.currentDevice?.id!,
      packageData
    );
    // 监听返回特征自动发包
    task.nextWithMonitor();
    // 等待任务完成
    await task.promise;
    return true;
  }

  /**
   * 设置通知类型gif
   */
  public async settingNotifyAppGif(url: string, packageName: string) {
    await this.prevCheckDevice();
    const packageData = await pkg_settingNotifyAppGif(url, packageName);
    // 创建任务
    const task = await TaskPoolInstance.createTask(
      this.currentDevice?.id!,
      packageData
    );
    // 监听返回特征自动发包
    task.nextWithMonitor();
    // 等待任务完成
    await task.promise;
    return true;
  }

  /**
   * 设置亮度
   */
  public async settingBrightness(value: number) {
    await this.prevCheckDevice();
    const packageData = pkg_settingBrightness(value);
    // 创建任务
    const task = await TaskPoolInstance.createTask(
      this.currentDevice?.id!,
      packageData
    );
    // 自动发包
    task.nextWhileTrue();
    // 等待任务完成
    await task.promise;
    return true;
  }

  /**
   * 设置显示时长
   */
  public async settingDisplayTime(value: number) {
    await this.prevCheckDevice();
    const packageData = pkg_settingDisplayTime(value);
    // 创建任务
    const task = await TaskPoolInstance.createTask(
      this.currentDevice?.id!,
      packageData
    );
    // 监听返回特征自动发包
    task.nextWithMonitor();
    // 等待任务完成
    await task.promise;
    return true;
  }

  /**
   * 重置手机壳
   */
  public async resetPhoneCase() {
    await this.prevCheckDevice();
    const packageData = pkg_reset();
    // 创建任务
    const task = await TaskPoolInstance.createTask(
      this.currentDevice?.id!,
      packageData
    );
    // 监听返回特征自动发包
    task.nextWithMonitor();
    // 等待任务完成
    await task.promise;
    return true;
  }

  /**
   * 申请蓝牙权限
   * @returns
   */
  public async requestBluetoothPermission() {
    if (Platform.OS === "ios") {
      return true;
    }
    if (Platform.OS === "android") {
      const apiLevel = parseInt(Platform.Version.toString(), 10);

      if (
        apiLevel < 31 &&
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      ) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      }
      if (
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN &&
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
      ) {
        const result = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]);

        return (
          result["android.permission.BLUETOOTH_CONNECT"] ===
            PermissionsAndroid.RESULTS.GRANTED &&
          result["android.permission.BLUETOOTH_SCAN"] ===
            PermissionsAndroid.RESULTS.GRANTED
        );
      }
    }

    return false;
  }

  /**
   * 获取错误提示语
   * @param err
   * @returns
   */
  public getErrorTipsByError(err: unknown) {
    let msg: string | null = null;
    if (err instanceof BleServiceError) {
      switch (err.state) {
        case BluetoothState.PoweredOff:
          msg = t("4da10b3bb25c36ce89534025ebc1f982");
          break;
        case BluetoothState.Unsupported:
          msg = t("d17d58027012e4067838f91b1162e2ad");
          break;
        case BluetoothState.Unknown:
          msg = t("a527d840aed18b3cfd747a1be2ccff0f");
          break;
      }
    }
    return msg;
  }

  /**
   * 同步根据设备id判断是否已经连接
   * 如果设备未连接会异步的移除
   * @param deviceId
   * @returns
   */
  public judgeDeviceIsConnectingAsync(deviceId: DeviceId) {
    const exists = this.connectingDevices.has(deviceId);
    if (exists) {
      this.connectingDevices
        .get(deviceId)
        ?.isConnected()
        .then((isConnected) => {
          if (!isConnected) {
            this.connectingDevices.delete(deviceId);
            TaskPoolInstance.clearTaskByDeviceId(deviceId);
            this.onDeviceChange(null);
          }
        });
    }
    return exists;
  }

  private onBluetoothStateChange(state: BluetoothState) {
    this.state = state;
    this.emit(BleServiceEvent.STATE_CHANGE, state);
  }

  private async onDeviceChange(device: Device | null) {
    let isConnecting = device ? await device.isConnected() : false;
    if (isConnecting) {
      const sortDevice = device as SortDevice;
      sortDevice.ts = +new Date();
      this.connectingDevices.set(device!.id, sortDevice);
    }
    if (
      this.currentDevice &&
      !this.connectingDevices.has(this.currentDevice.id)
    ) {
      // 设备断开连接
      this.currentDevice = null;
    } else if (
      this.currentDevice === null ||
      !this.connectingDevices.has(this.currentDevice.id)
    ) {
      // 自动选择一个设备
      if (isConnecting) {
        this.currentDevice = device;
      }
      // 自动选择另外一个设备
      // else if (this.connectingDevices.size > 0) {
      //   try {
      //     Array.from(this.connectingDevices.values())
      //       .sort((a, b) => a.ts - b.ts)
      //       .forEach(async (device) => {
      //         if (await device.isConnected()) {
      //           this.currentDevice = device;
      //           throw new Error();
      //         }
      //       });
      //   } catch (ignore) {}
      // }
    }
    this.emit(BleServiceEvent.DEVICE_CHANGE, device);
  }

  private onConnectedDeviceChange(device: Device | null) {
    this.emit(BleServiceEvent.CONNECTED_DEVICE_CHANGE, device);
  }

  private onFoundedDeviceChange(device: Device) {
    this.foundDevices.set(device.id, device);
    this.emit(BleServiceEvent.FOUNDED_DEVICE_CHANGE, device);
  }

  private onFoundedDeviceClear() {
    this.foundDevices.clear();
    this.emit(BleServiceEvent.FOUNDED_DEVICE_CHANGE, null);
  }

  private onError(error: unknown) {
    if (!(error instanceof Error)) return;
    console.error("error", error.message);
  }
}

export const BleServiceInstance = new BleService();
