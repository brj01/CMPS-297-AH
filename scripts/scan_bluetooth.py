import asyncio
from sensors.imu_bluetooth import BluetoothImu

async def main():
    for device in await BluetoothImu.scan():
        print(f"{device['name']}\t{device['address']}")

if __name__ == "__main__":
    asyncio.run(main())
