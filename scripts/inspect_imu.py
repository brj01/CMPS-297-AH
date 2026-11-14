"""Print raw/decoded notifications after connecting to an address."""
import argparse
import asyncio
from sensors.imu_bluetooth import BluetoothImu

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("address")
    args = parser.parse_args()
    event = asyncio.Event()
    imu = BluetoothImu(lambda reading: print(reading))
    await imu.connect(args.address)
    await event.wait()

if __name__ == "__main__":
    asyncio.run(main())
