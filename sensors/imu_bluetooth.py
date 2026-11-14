import asyncio
import time
from typing import Callable, Any
from .witmotion_parser import PacketStream

class BluetoothImu:
    def __init__(self, on_reading: Callable[[Any], None]) -> None:
        self.on_reading = on_reading
        self.client = None
        self.device = None
        self.connected = False
        self.notification_characteristic = None
        self._reconnect_task = None
        self._disconnect_requested = False

    @staticmethod
    async def scan() -> list[dict[str, str]]:
        from bleak import BleakScanner
        return [{"name": d.name or "Unknown", "address": d.address} for d in await BleakScanner.discover()]

    async def _connect_once(self, address: str) -> None:
        from bleak import BleakClient
        self.client = BleakClient(address, disconnected_callback=self._on_disconnect)
        await self.client.connect()
        services = self.client.services
        characteristics = [c for s in services for c in s.characteristics if "notify" in c.properties]
        if not characteristics:
            await self.client.disconnect()
            raise RuntimeError("Device exposes no notification characteristic")
        stream = PacketStream()
        def callback(_: int, data: bytearray) -> None:
            for reading in stream.feed(bytes(data), time.time()):
                self.on_reading(reading)
        await self.client.start_notify(characteristics[0].uuid, callback)
        self.notification_characteristic = characteristics[0].uuid
        self.device, self.connected = address, True

    def _on_disconnect(self, _client) -> None:
        self.connected = False
        self.notification_characteristic = None
        if self.device and not self._disconnect_requested and (
            self._reconnect_task is None or self._reconnect_task.done()
        ):
            self._reconnect_task = asyncio.create_task(self._reconnect())

    async def _reconnect(self) -> None:
        while self.device and not self._disconnect_requested:
            await asyncio.sleep(2)
            try:
                await self._connect_once(self.device)
            except (OSError, RuntimeError, asyncio.TimeoutError):
                continue
            return

    async def connect(self, address: str) -> None:
        self._disconnect_requested = False
        self.device = address
        await self._connect_once(address)

    async def disconnect(self) -> None:
        self._disconnect_requested = True
        self.device = None
        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()
        if self.client:
            await self.client.disconnect()
        self.connected = False
        self.notification_characteristic = None
