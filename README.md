# Nori (NoriJS) Engine Media Playback Engine

A custom browser-based media playback engine designed for **progressive, range-based playback of MKV and MP4 media**.

The player is designed around a key idea:

> **The entire media file does not need to be available before playback can begin.**

Instead, the playback pipeline discovers the structure of a media container, requests only the byte ranges required for the current playback position, parses those ranges, and progressively feeds browser-compatible media data into the playback pipeline.

The implementation currently supports:

* **Matroska (`.mkv`)**
* **ISO Base Media File Format / MP4 (`.mp4`)**
* Random-access seeking
* Progressive buffering
* Video and audio tracks
* Embedded subtitle discovery/extraction for supported Matroska subtitle formats
* External subtitle discovery
* MediaSource Extensions (MSE) based MP4 playback
* Range-based data acquisition
* Session-aware seeking and buffer refilling
* Diagnostic logging and playback state tracking

---

# Architecture

The player is divided into several logical layers:

```text
                    ┌──────────────────────┐
                    │    Player UI / MSE   │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Playback Controller  │
                    │  Buffer / Seeking    │
                    └──────────┬───────────┘
                               │
                  ┌────────────┴────────────┐
                  ▼                         ▼
          ┌──────────────┐         ┌──────────────┐
          │ MKV Pipeline │         │ MP4 Pipeline │
          └──────┬───────┘         └──────┬───────┘
                 │                        │
                 ▼                        ▼
        ┌────────────────┐       ┌────────────────┐
        │ MKV Metadata   │       │ MP4 Demuxer    │
        │ + Cluster      │       │ / Parser       │
        │ Parsing        │       │                │
        └───────┬────────┘       └───────┬────────┘
                │                        │
                └──────────┬─────────────┘
                           ▼
                 ┌─────────────────────┐
                 │ MediaDataSource     │
                 │ Range-based access  │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │ Media Source /      │
                 │ Range Provider      │
                 └─────────────────────┘
```

The `MediaDataSource` acts as the parser-facing interface. Parsers request a specific byte range rather than directly managing the underlying transport.

---

# 1. Range-Based MediaDataSource

The playback engine uses a common data-access abstraction:

```text
Parser
   │
   │ getBytes(offset, length)
   ▼
MediaDataSource
   │
   ▼
Range Manager
   │
   ├── already available → read immediately
   │
   └── unavailable → request range
                         │
                         ▼
                    wait for data
                         │
                         ▼
                    read bytes
```

This separation is important because the container parser does not need to know how media bytes are obtained.

The parser simply asks:

```text
getBytes(fileId, filePath, offset, length)
```

The data source first ensures that the requested range is available and then reads exactly that region. MediaDataSource.jsJS

### Advantages

* Parser and transport are decoupled.
* Random access is possible.
* Large files do not have to be loaded completely.
* MKV and MP4 implementations can share the same data-access mechanism.
* Additional container formats can use the same interface.

---

# 2. MKV Playback Pipeline

Matroska is an EBML-based container, so playback requires understanding its hierarchical structure.

The MKV pipeline performs structural metadata discovery before normal playback.

```text
MKV
 │
 ├── EBML
 │
 ├── Segment
 │
 ├── SeekHead
 │
 ├── Info
 │
 ├── Tracks
 │
 ├── Cues
 │
 └── Clusters
       │
       ├── Video
       ├── Audio
       └── Subtitle
```

The metadata engine maintains information such as:

* Track definitions
* Track numbers
* Duration
* Timecode scale
* Segment offsets
* Cue information
* Cluster locations

The implementation separates the critical metadata path from background indexing work. Header and track information are resolved first, while cues and the first cluster can be processed in the background.

---

# 3. MKV Seeking

One of the most important parts of the MKV implementation is **time → cluster resolution**.

When the user seeks to:

```text
02:35:20
```

the player does not start reading from an arbitrary byte near that point.

Instead:

```text
Requested time
      │
      ▼
Cue lookup
      │
      ▼
Nearest suitable cluster
      │
      ▼
Cluster byte offset
      │
      ▼
Range request
      │
      ▼
Cluster parser
      │
      ▼
Audio / Video packets
```

The metadata engine first tries track-specific cues and can fall back to a global cue search when the track-specific index is sparse or significantly behind the requested position.

This is important for MKV because a seek should begin at a **valid Cluster boundary**, rather than arbitrarily in the middle of an EBML structure.

---

# 4. MKV Cluster Parser

The `ClusterManager` manages individual Matroska clusters.

Each cluster maintains state such as:

```text
Cluster
 ├── offset
 ├── packets
 ├── parseState
 ├── parserPosition
 ├── clusterTimecode
 ├── dataOffset
 ├── endOffset
 └── headerParsed
```

The manager also prevents multiple parsing operations from independently processing the same cluster. clusterManager.jsJS

This allows a seek and subsequent buffer requests to reuse already parsed cluster information.

---

# 5. Progressive MKV Playback

The MKV pipeline does not require the entire file.

A simplified flow is:

```text
Find cluster
     │
     ▼
Request cluster bytes
     │
     ▼
Parse Cluster
     │
     ├── Video packets
     ├── Audio packets
     └── Subtitle packets
     │
     ▼
Serialize required track
     │
     ▼
Progressive response
     │
     ▼
Browser playback
```

For audio, the implementation can serialize supported Matroska audio tracks into browser-consumable formats.

For example, the WebM audio serializer produces an audio-only WebM stream for Opus/Vorbis. WebMAudioSerializer.jsJS

AAC tracks can similarly be converted into an ADTS stream by generating an appropriate ADTS header for each AAC access unit. AACSerializer.jsJS

---

# 6. MP4 Playback Pipeline

MP4 follows a different architecture because ISO BMFF is box-based rather than EBML-based.

The pipeline begins by locating important boxes such as:

```text
ftyp
moov
mdat
```

The MP4 backend performs a structural probe and searches for the `ftyp` and `moov` boxes. If the metadata is not found near the beginning of the file, the implementation also probes the tail of the file.

Conceptually:

```text
MP4
 │
 ├── ftyp
 │
 ├── moov
 │    ├── Tracks
 │    ├── Sample tables
 │    ├── Timing information
 │    └── Chunk/sample locations
 │
 └── mdat
      └── Media samples
```

---

# 7. MP4 Demuxing

The current implementation uses **MP4Box.js** as its MP4/ISO BMFF parser and demuxing component. MP4Backend.jsJS

However, this is intentionally an implementation choice rather than a fundamental requirement.

A different MP4/ISO BMFF demuxer can be substituted as long as it can provide the information required by the playback pipeline, such as:

* Track information
* Codec information
* Sample timing
* Sample locations
* Sample sizes
* Keyframe/random-access information
* Initialization metadata

This makes the MP4 architecture adaptable to other demuxing libraries or a custom ISO BMFF parser.

---

# 8. MP4 → MediaSource Extensions

The MP4 player uses the browser's **MediaSource Extensions (MSE)** API.

The high-level pipeline is:

```text
MP4 file
   │
   ▼
MP4 parser / demuxer
   │
   ▼
Track metadata + samples
   │
   ▼
Fragmented MP4
   │
   ├───────────────┐
   ▼               ▼
Video SourceBuffer Audio SourceBuffer
   │               │
   └───────┬───────┘
           ▼
       MediaSource
           │
           ▼
       HTMLVideoElement
```

The MP4 player creates separate SourceBuffers for supported video and audio tracks.

This allows the browser to perform the final decoding while the application controls how media data is fetched, buffered and appended.

---

# 9. MP4 Buffer Management

The MP4 buffer controller is responsible for:

* Segment scheduling
* Buffering
* SourceBuffer append serialization
* Seeking
* Rebuffering
* Buffer eviction
* Queue management

The implementation uses configurable buffering targets:

```text
Forward buffer goal     = 20 seconds
Rebuffering threshold    = 5 seconds
Back buffer              = 15 seconds
```

The important design principle is that **network delivery and SourceBuffer appending are separate operations**.

```text
Network
   │
   ▼
Segment Queue
   │
   ▼
SourceBuffer
   │
   ▼
Browser decoder
```

This prevents a fast data source from overwhelming the `SourceBuffer` append pipeline.

---

# 10. Queue Drain / Playback Heartbeat

A particularly important part of the buffering architecture is the playback heartbeat.

The controller periodically checks the internal queues and processes pending segments even if the network request has already completed.

```text
Network finishes
       │
       ▼
Segments remain queued
       │
       ▼
Heartbeat
       │
       ▼
_processAllQueues()
       │
       ▼
SourceBuffer
       │
       ▼
Playback continues
```

The current implementation runs the heartbeat every second and actively drains pending queues. MP4BufferController.jsJS

This helps avoid a class of stalls where data has already arrived but has not yet been appended to the media buffer.

---

# 11. MP4 Seeking

Seeking creates a new playback generation.

The MP4 player maintains state for:

```text
IDLE
DISCOVERING
READY
SEEKING
BUFFERING
PLAYING
STOPPED
```

It also maintains an internal seek guard and pending seek information to prevent unwanted feedback between browser seeking and application-controlled seeking. MP4MSEPlayer.jsJS

The conceptual flow is:

```text
User moves seek bar
        │
        ▼
New target timestamp
        │
        ▼
Create new playback generation
        │
        ▼
Abort obsolete fetches
        │
        ▼
Resolve required media range
        │
        ▼
Generate new media segments
        │
        ▼
Append to SourceBuffers
        │
        ▼
Resume playback
```

---

# 12. Session and Refill Management

Seeking and normal buffering are treated differently.

A **new seek** creates a new playback generation.

A **buffer refill belonging to the same generation** can reuse the existing playback session.

```text
Generation 10

Seek
  ↓
NEW PLAYBACK SESSION

Buffer refill
  ↓
REFILL
  ↓
Reuse existing session
```

The transport layer explicitly distinguishes these cases.

This prevents normal buffer refills from unnecessarily destroying active playback state.

---

# 13. Handling Stale Requests

Another important part of the architecture is cancellation.

If a user seeks from:

```text
00:10:00
```

to:

```text
01:20:00
```

requests associated with the old playback generation should no longer block the new seek.

The range layer therefore supports abort signals and session-aware requests.

This gives the pipeline:

```text
Old seek
   │
   ├── pending range requests
   ├── parsing
   └── network operations
          │
          ▼
       ABORT
          │
          ▼
New seek
          │
          ▼
New range requests
```

The transport implementation also wakes stale range listeners when a new playback session begins, allowing them to terminate rather than waiting indefinitely. TransportManager.jsJS

---

# 14. Backend Resolution

The player detects the container before selecting the appropriate playback backend.

The resolver performs signature-based detection:

```text
File bytes
    │
    ├── EBML signature → MKV
    │
    └── "ftyp" box → MP4
```

It also has an extension fallback when structural sniffing is inconclusive.

Backend resolution is cached, and simultaneous resolution requests are de-duplicated so multiple requests do not repeatedly perform the same probing operation. AudioStreamOrchestrator.jsJS

---

# 15. Subtitle Architecture

The MKV pipeline also exposes subtitle tracks.

Supported text subtitle codecs include formats such as:

```text
S_TEXT/UTF8
S_TEXT/ASS
S_TEXT/SSA
```

The subtitle system can also discover external:

```text
.srt
.ass
.ssa
.vtt
```

subtitle files.

Subtitle streaming uses the same general random-access architecture:

```text
Seek timestamp
      │
      ▼
Find relevant MKV cluster
      │
      ▼
Read cluster
      │
      ▼
Extract subtitle packets
      │
      ▼
Convert to WebVTT
      │
      ▼
Browser subtitle track
```

The subtitle pipeline resolves a starting cluster based on the requested timestamp rather than scanning the entire file. subtitleManager.jsJS

---

# 16. Why This Architecture Is Useful

Traditional playback can assume that a media file is already completely accessible.

This project instead treats the media file as a **random-access byte-addressable resource**.

That enables:

### Progressive playback

Only the required portions of a large media file need to be acquired.

### Random seeking

The player can locate the physical media region corresponding to a timestamp.

### Reduced initial latency

Playback can begin without waiting for the entire file.

### Container-aware processing

MKV and MP4 can have completely different parsing pipelines while sharing the same data-access layer.

### Extensibility

New containers can be implemented by adding:

```text
Container Detector
       │
       ▼
Metadata Parser
       │
       ▼
Timestamp → Byte Resolver
       │
       ▼
Sample / Packet Extractor
       │
       ▼
Browser-compatible serializer
```

---

# 17. Adding Another Media Format

The architecture is designed so another format does not need to modify the entire player.

For a new container, implement:

### 1. Container detection

Determine whether the file belongs to the new format.

### 2. Metadata parser

Extract:

* Tracks
* Codecs
* Duration
* Timing
* Random-access information
* Sample locations

### 3. Range-aware parser

Use `MediaDataSource` to request only the byte ranges required by the parser.

### 4. Timestamp → byte mapping

Implement:

```text
timestamp → physical file position
```

This is essential for efficient seeking.

### 5. Sample extraction

Extract the required audio/video samples.

### 6. Browser-compatible output

Depending on the format, either:

* feed samples into MSE,
* generate fragmented MP4,
* generate WebM,
* generate another browser-compatible stream,
* or use another appropriate browser playback mechanism.

---

# 18. Design Principles

The project follows several important engineering principles.

### Separation of concerns

Container parsing, range access, buffering and playback are separate components.

### Random access

The system is designed around byte-range access rather than sequentially downloading an entire file.

### Lazy processing

Data is parsed when needed instead of eagerly parsing the complete media file.

### Caching

Metadata, parsed clusters and backend resolution can be reused.

### Concurrency control

Multiple requests for the same work are coordinated rather than blindly duplicated.

### Cancellation

Obsolete work from previous seeks can be terminated.

### Browser-native decoding

The application handles container processing and media delivery while the browser remains responsible for final codec decoding.

---

# 19. Current Format Support

| Format     | Container Processing        | Seeking | Progressive Playback | Audio | Subtitles |
| ---------- | --------------------------- | ------- | -------------------- | ----- | --------- |
| MKV        | Custom EBML/Matroska parser | ✅       | ✅                    | ✅     | ✅         |
| MP4        | MP4Box.js / ISO BMFF        | ✅       | ✅                    | ✅     | —         |
| WebM audio | WebM serializer             | —       | ✅                    | ✅     | —         |
| AAC audio  | ADTS serializer             | —       | ✅                    | ✅     | —         |

The WebM and AAC components are currently supporting pieces of the broader media pipeline rather than the primary video-container implementations. WebMAudioSerializer.jsJS AACSerializer.jsJS

---

# 20. Technical Highlights

Some of the technically interesting parts of the project are:

* EBML/Matroska structural parsing
* MKV `SeekHead`, `Tracks`, `Info`, `Cues` and `Cluster` processing
* Timestamp-to-cluster resolution
* Random-access media reading
* Incremental cluster parsing
* MP4 `ftyp`/`moov` discovery
* MP4 demuxing with a replaceable demuxer layer
* Fragmented MP4 generation
* MediaSource Extensions
* Multiple `SourceBuffer` management
* Independent audio/video buffering
* Seek generations
* Request cancellation
* Buffer refill session reuse
* Queue draining
* Back-buffer eviction
* Subtitle extraction and WebVTT conversion
* Diagnostic and synchronization logging

---

# Project Summary

**Nori Engine** is a custom range-based media playback architecture that bridges the gap between raw container formats and browser-native playback.

Instead of treating a video as a simple sequential byte stream, it understands the internal structure of the container and uses that structure to answer a fundamental playback question:

> **"Which bytes are actually required to play this timestamp?"**

For MKV, this is achieved through EBML/Matroska metadata, cues and cluster-aware parsing. For MP4, the implementation uses ISO BMFF structure and MP4Box.js for demuxing. Both pipelines ultimately share the same range-oriented data-access concept while using format-specific processing internally. mkvMetaEngine.jsJS MP4Backend.jsJS

The architecture is intentionally extensible, allowing another suitable demuxer or parser to replace the current MP4Box.js implementation and allowing additional container formats to be added without redesigning the entire playback system.
