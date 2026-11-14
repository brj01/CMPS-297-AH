import asyncio
import time

from bleak import BleakClient, BleakScanner

from sensors.witmotion_parser import PacketStream

ADDRESS = "E7:F8:C0:49:D9:44"


async def main() -> None:
    print(f"Searching for IMU at {ADDRESS}...")
    device = await BleakScanner.find_device_by_address(ADDRESS, timeout=15)
    if device is None:
        print("IMU not found. Check that it is powered on and WitMotion software is closed.")
        return

    print(f"IMU found: {device.name or 'Unnamed device'}")
    stream = PacketStream()

    def receive_data(_: int, data: bytearray) -> None:
        for reading in stream.feed(bytes(data), time.time()):
            print(
                "ACC: "
                f"{reading.acc[0]: .3f}, {reading.acc[1]: .3f}, {reading.acc[2]: .3f} | "
                "GYRO: "
                f"{reading.gyro[0]: .2f}, {reading.gyro[1]: .2f}, {reading.gyro[2]: .2f} | "
                "ANGLE: "
                f"{reading.orientation[0]: .2f}, {reading.orientation[1]: .2f}, "
                f"{reading.orientation[2]: .2f}"
            )

    async with BleakClient(device) as client:
        print("CONNECTED SUCCESSFULLY!")
        notify_chars = [
            characteristic
            for service in client.services
            for characteristic in service.characteristics
            if "notify" in characteristic.properties
        ]
        preferred = next(
            (characteristic for characteristic in notify_chars if "ffe4" in characteristic.uuid.lower()),
            None,
        )
        notify_char = preferred or (notify_chars[0] if notify_chars else None)
        if notify_char is None:
            print("Notification characteristic not found.")
            for service in client.services:
                for characteristic in service.characteristics:
                    print(characteristic.uuid, characteristic.properties)
            return

        print(f"Characteristic: {notify_char.uuid}")
        await client.start_notify(notify_char, receive_data)
        print("Receiving live IMU data. Move your pen; press Ctrl+C to stop.")
        while client.is_connected:
            await asyncio.sleep(1)

    print("IMU disconnected.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nConnection closed.")
