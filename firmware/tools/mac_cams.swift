// Prints the Mac's video devices the way OpenCV numbers them, one per line: "<index>\t<name>".
// OpenCV's AVFoundation backend sorts the devices by uniqueID (macOS's own list order changes
// from run to run), so trax can open a webcam by name with cv2.VideoCapture(index).
// Built by board.py on first use.
import AVFoundation
let devices = (AVCaptureDevice.devices(for: .video) + AVCaptureDevice.devices(for: .muxed))
  .sorted { $0.uniqueID.compare($1.uniqueID) == .orderedAscending }
for (i, d) in devices.enumerated() { print("\(i)\t\(d.localizedName)") }
