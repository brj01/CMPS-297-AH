import numpy as np
from processing.feature_extraction import extract_features

def test_feature_shape():
    assert extract_features(np.zeros((2, 155, 6))).shape == (2, 155, 14)

