import struct
from sensors.witmotion_parser import parse_packet, PacketStream

def test_packet_parser_and_stream():
    packet = b"\x55\x61" + struct.pack("<9h", *range(-4, 5))
    reading = parse_packet(packet, 1.0)
    assert reading and reading.timestamp == 1.0 and reading.acc[0] < 0
    assert len(PacketStream().feed(packet)) == 1

