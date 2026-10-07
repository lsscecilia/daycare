// Local screenshot OCR with Apple's Vision framework. Nothing leaves the machine.
// Usage: ocr <image.png>   → recognised text, one line per text block, top to bottom.
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count == 2,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("usage: ocr <image>\n".data(using: .utf8)!)
  exit(2)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
do {
  try VNImageRequestHandler(cgImage: cg).perform([request])
} catch {
  FileHandle.standardError.write("ocr failed: \(error)\n".data(using: .utf8)!)
  exit(1)
}
for o in request.results ?? [] {
  if let line = o.topCandidates(1).first?.string { print(line) }
}
