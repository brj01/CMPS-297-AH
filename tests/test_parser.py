import struct
from sensors.witmotion_parser import parse_packet, PacketStream

def test_packet_parser_and_stream():
    packet = b"\x55\x61" + struct.pack("<9h", *range(-4, 5))
    reading = parse_packet(packet, 1.0)
    assert reading and reading.timestamp == 1.0 and reading.acc[0] < 0
    assert len(PacketStream().feed(packet)) == 1


def test_packets_in_one_notification_get_increasing_timestamps():
    packet = b"\x55\x61" + struct.pack("<9h", *range(-4, 5))
    stream = PacketStream(sample_period=0.01)
    first = stream.feed(packet * 3, 10.0)
    assert [round(r.timestamp, 6) for r in first] == [9.98, 9.99, 10.0]
    # a later notification that arrives "too early" must still move forward in time
    second = stream.feed(packet * 2, 10.005)
    times = [r.timestamp for r in first + second]
    assert all(b > a for a, b in zip(times, times[1:]))
