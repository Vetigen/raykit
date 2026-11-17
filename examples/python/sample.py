"""Read one frame and one physical point with an installed RayKit wheel."""

import argparse
import json

from raykit_dicom import Session

parser = argparse.ArgumentParser()
parser.add_argument("source")
parser.add_argument("--frame", type=int, required=True)
parser.add_argument("--x", type=int, required=True)
parser.add_argument("--y", type=int, required=True)
args = parser.parse_args()

with Session(args.source) as image:
    values, metadata = image.frame(args.frame)
    print(json.dumps({
        "source": metadata["source"], "shape": values.shape, "dtype": str(values.dtype),
        "sample": image.sample(args.frame, args.x, args.y),
    }))
