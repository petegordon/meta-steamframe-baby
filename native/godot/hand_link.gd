class_name HandLink
extends RefCounted
## Receives hand poses from the camera hand tracker running on the same headset
## (spyjacob/steam-frame-hand-tracking, "FhHandPacket" over UDP port 47811).
##
## We subscribe exactly like its PC driver does (a small "ping" every second),
## just from 127.0.0.1, so the tracker needs no changes.
## Poses are in the head frame: +x right, +y up, -z forward, metres.

const MAGIC := 0x444E4846  # "FHND"
const PORT := 47811
const HAND_BYTES := 80     # valid, conf, pos[3], quat[4] (w,x,y,z), ageMs, curl[5], splay[5]


class HandSample:
	var valid := false
	var confidence := 0.0
	var pos := Vector3.ZERO                    ## palm centre, head frame (m)
	var rot := Quaternion.IDENTITY             ## head-from-palm: -z along fingers, +y back of hand
	var curls := PackedFloat32Array([0, 0, 0, 0, 0])  ## thumb..pinky, 0 open .. 1 curled
	var capture_usec := 0                      ## local Time.get_ticks_usec() when the camera saw it


var hands: Array[HandSample] = [HandSample.new(), HandSample.new()]  # [left, right]
var packets := 0
var last_packet_usec := 0
var _udp := PacketPeerUDP.new()
var _last_subscribe_usec := -10_000_000


func _init(host := "127.0.0.1", port := PORT) -> void:
	var err := _udp.connect_to_host(host, port)
	if err != OK:
		push_error("HandLink: can't open UDP to %s:%d (%s)" % [host, port, error_string(err)])


func poll() -> void:
	var now := Time.get_ticks_usec()
	if now - _last_subscribe_usec > 1_000_000:
		_last_subscribe_usec = now
		var b := PackedByteArray()
		b.resize(24)
		b.encode_u32(0, MAGIC)
		b.encode_u32(4, 3)   # protocol version
		b.encode_u32(8, 1)   # kind: subscribe/ping
		b.encode_u32(12, 0)
		b.encode_u64(16, now * 1000)
		_udp.put_packet(b)
	while _udp.get_available_packet_count() > 0:
		_parse(_udp.get_packet(), now)


func seconds_since_packet() -> float:
	if last_packet_usec == 0:
		return INF
	return (Time.get_ticks_usec() - last_packet_usec) / 1e6


func _parse(p: PackedByteArray, now: int) -> void:
	if p.size() < 8 or p.decode_u32(0) != MAGIC:
		return
	var ver := p.decode_u32(4)
	var head := 32 if ver >= 3 else 24
	if p.size() < head + 2 * HAND_BYTES:
		return  # e.g. the "pong" reply to our ping
	packets += 1
	last_packet_usec = now
	for i in 2:
		var o := head + i * HAND_BYTES
		var h := hands[i]
		h.valid = p.decode_u32(o) == 1
		if not h.valid:
			continue
		h.confidence = p.decode_float(o + 4)
		h.pos = Vector3(p.decode_float(o + 8), p.decode_float(o + 12), p.decode_float(o + 16))
		var w := p.decode_float(o + 20)
		h.rot = Quaternion(p.decode_float(o + 24), p.decode_float(o + 28), p.decode_float(o + 32), w).normalized()
		var age_ms := p.decode_float(o + 36)
		h.capture_usec = now - int(clampf(age_ms, 0.0, 500.0) * 1000.0)
		for f in 5:
			h.curls[f] = p.decode_float(o + 40 + f * 4)
