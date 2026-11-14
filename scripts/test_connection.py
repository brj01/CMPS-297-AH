import asyncio
from sensors.imu_bluetooth import BluetoothImu

async def main():
    devices = await BluetoothImu.scan()
    print(f"Found {len(devices)} BLE devices")
    for device in devices:
        print(device)

if __name__ == "__main__":
    asyncio.run(main())
