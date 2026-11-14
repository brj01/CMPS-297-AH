from processing.segmentation import Segmenter, State

def test_segmenter_starts_on_motion():
    segmenter = Segmenter()
    segmenter.update({"acc": (1, 0, 1), "gyro": (3, 0, 0)}, 0)
    assert segmenter.state == State.WRITING

