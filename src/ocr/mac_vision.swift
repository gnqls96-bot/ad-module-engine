// 맥 내장 글자 인식 (Vision). 이미지 여러 장을 받아 JSON 한 줄로 출력한다.
// 사용: ame-ocr <이미지1> <이미지2> ...
// 출력: [{"file": "...", "lines": [{"text": "...", "conf": 0.9, "x": 0.1, "y": 0.8, "w": 0.5, "h": 0.05}]}]
// 좌표는 화면 비율(0~1), y는 위에서부터.
import Foundation
import Vision

struct Line: Codable { let text: String; let conf: Float; let x: Double; let y: Double; let w: Double; let h: Double }
struct Result: Codable { let file: String; let lines: [Line]; let error: String? }

var results: [Result] = []
for file in CommandLine.arguments.dropFirst() {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.recognitionLanguages = ["ko-KR", "en-US"]
  req.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(url: URL(fileURLWithPath: file), options: [:])
  do {
    try handler.perform([req])
    let lines: [Line] = (req.results ?? []).compactMap { obs in
      guard let c = obs.topCandidates(1).first else { return nil }
      let b = obs.boundingBox
      return Line(text: c.string, conf: c.confidence, x: b.minX, y: 1 - b.maxY, w: b.width, h: b.height)
    }
    results.append(Result(file: file, lines: lines, error: nil))
  } catch {
    results.append(Result(file: file, lines: [], error: "\(error)"))
  }
}
FileHandle.standardOutput.write(try! JSONEncoder().encode(results))
