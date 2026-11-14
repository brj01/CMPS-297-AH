from dataclasses import dataclass
import struct

PACKET_LENGTH = 20

@dataclass(frozen=True)
class ImuReading:
    timestamp: float
    acc: tuple[float, float, float]
    gyro: tuple[float, float, float]
    orientation: tuple[float, float, float]
    raw: bytes

def parse_packet(packet: bytes, timestamp: float = 0.0) -> ImuReading | None:
    if len(packet) != PACKET_LENGTH or packet[:2] != b"\x55\x61":
        return None
    values = struct.unpack("<9h", packet[2:20])
    # WT9011DCL 0x61 payload: acceleration in 1/32768 g,
    # angular velocity in 1/32768 of 2000 dps, angles in 1/32768 of 180 degrees.
    return ImuReading(
        timestamp,
        tuple(v / 32768.0 * 16.0 for v in values[0:3]),
        tuple(v / 32768.0 * 2000.0 for v in values[3:6]),
        tuple(v / 32768.0 * 180.0 for v in values[6:9]),
        bytes(packet),
    )

class PacketStream:
    def __init__(self) -> None:
        self.buffer = bytearray()

    def feed(self, data: bytes, timestamp: float = 0.0) -> list[ImuReading]:
        self.buffer.extend(data)
        readings: list[ImuReading] = []
        while True:
            start = self.buffer.find(b"\x55\x61")
            if start < 0:
                self.buffer.clear()
                break
            if start:
                del self.buffer[:start]
            if len(self.buffer) < PACKET_LENGTH:
                break
            packet = bytes(self.buffer[:PACKET_LENGTH])
            del self.buffer[:PACKET_LENGTH]
            parsed = parse_packet(packet, timestamp)
            if parsed is not None:
                readings.append(parsed)
        return readings

