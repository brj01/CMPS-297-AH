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
    """Reassembles packets from BLE notifications.

    One notification often carries several packets, but they all arrive with a
    single receive time. Each packet gets its own timestamp, spaced
    ``sample_period`` apart and ending at the receive time, so timestamps are
    always strictly increasing (later processing steps require that).
    """

    MIN_GAP = 1e-3

    def __init__(self, sample_period: float = 0.01) -> None:
        self.buffer = bytearray()
        self.sample_period = sample_period
        self.last_timestamp: float | None = None

    def feed(self, data: bytes, timestamp: float = 0.0) -> list[ImuReading]:
        self.buffer.extend(data)
        packets: list[bytes] = []
        while True:
            start = self.buffer.find(b"\x55\x61")
            if start < 0:
                self.buffer.clear()
                break
            if start:
                del self.buffer[:start]
            if len(self.buffer) < PACKET_LENGTH:
                break
            packets.append(bytes(self.buffer[:PACKET_LENGTH]))
            del self.buffer[:PACKET_LENGTH]
        readings: list[ImuReading] = []
        for index, packet in enumerate(packets):
            packet_time = timestamp - (len(packets) - 1 - index) * self.sample_period
            if self.last_timestamp is not None:
                packet_time = max(packet_time, self.last_timestamp + self.MIN_GAP)
            parsed = parse_packet(packet, packet_time)
            if parsed is not None:
                readings.append(parsed)
                self.last_timestamp = packet_time
        return readings

