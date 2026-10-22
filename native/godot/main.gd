extends Node3D
## Frame Hands: see your camera-tracked hands on Steam Frame, point at things,
## and make a fist to click buttons or grab blocks.
##
## Command-line options (after "--"):
##   --tracker-host=IP     where the hand tracker runs (default 127.0.0.1 = this headset)
##   --screenshot=PATH     desktop testing: save a screenshot and quit
##   --screenshot-ms=N     ...after N ms (default 4000)

const FIST_ON := 0.62      # mean curl of index..pinky that counts as a fist (click / grab)
const FIST_OFF := 0.42     # ...and that releases it
const STALE_USEC := 300_000
const RAY_LEN := 3.0
const PALETTE := [Color("ff6b6b"), Color("ffd93d"), Color("6bcb77"), Color("4d96ff"), Color("c77dff")]


class HandState:
	var side := ""
	var view: HandView
	var ray: MeshInstance3D
	var cursor: MeshInstance3D
	var tracked := false
	var fist := false
	var world := Transform3D()
	var grabbed: Node3D = null
	var grab_dist := 0.0
	var grab_offset := Vector3.ZERO
	var hover: Node3D = null


var link: HandLink
var cam: Camera3D  # XRCamera3D in VR
var xr_active := false
var hands: Array[HandState] = []
var status: Label3D
var build_info := "dev build"
var _head_hist: Array = []  # [usec, Transform3D], newest last
var _cubes: Array[Node3D] = []
var _clicks := 0
var _color_shift := 0
var _status_t := 0.0
var _screenshot := ""
var _screenshot_ms := 4000
var _ray_mat_idle: StandardMaterial3D
var _ray_mat_fist: StandardMaterial3D


func _ready() -> void:
	var host := "127.0.0.1"
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--tracker-host="):
			host = a.get_slice("=", 1)
		elif a.begins_with("--screenshot="):
			_screenshot = a.get_slice("=", 1)
		elif a.begins_with("--screenshot-ms="):
			_screenshot_ms = int(a.get_slice("=", 1))
	if FileAccess.file_exists("res://build_info.json"):
		var info = JSON.parse_string(FileAccess.get_file_as_string("res://build_info.json"))
		if info is Dictionary:
			build_info = "build %s · %s" % [info.get("commit", "?"), info.get("time", "?")]
	print("Frame Hands ", build_info, " · tracker at ", host)

	var xr := XRServer.find_interface("OpenXR")
	if xr and xr.is_initialized():
		xr_active = true
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
		get_viewport().use_xr = true
		print("OpenXR running: ", xr.get_name())
	else:
		print("OpenXR not available: running as a flat desktop window (for testing)")

	_build_world()
	var origin := XROrigin3D.new()
	add_child(origin)
	if xr_active:
		cam = XRCamera3D.new()
		origin.add_child(cam)
	else:
		# Flat test window: a fixed camera stands in for the head.
		cam = Camera3D.new()
		cam.position = Vector3(0, 1.55, 0.25)
		cam.rotation_degrees = Vector3(-8, 0, 0)
		add_child(cam)
	cam.near = 0.02
	cam.current = true

	_ray_mat_idle = _unshaded(Color(1, 1, 1, 0.55))
	_ray_mat_fist = _unshaded(Color(0.3, 1.0, 0.45, 0.9))
	for side in ["left", "right"]:
		var h := HandState.new()
		h.side = side
		h.view = HandView.new()
		h.view.setup(side, Color("55c8ff") if side == "left" else Color("ffa64d"))
		add_child(h.view)
		h.ray = MeshInstance3D.new()
		var cyl := CylinderMesh.new()
		cyl.top_radius = 0.002
		cyl.bottom_radius = 0.002
		cyl.height = 1.0
		cyl.radial_segments = 6
		h.ray.mesh = cyl
		h.ray.material_override = _ray_mat_idle
		h.ray.visible = false
		add_child(h.ray)
		h.cursor = MeshInstance3D.new()
		var dot := SphereMesh.new()
		dot.radius = 0.012
		dot.height = 0.024
		h.cursor.mesh = dot
		h.cursor.material_override = _unshaded(Color.WHITE)
		h.cursor.visible = false
		add_child(h.cursor)
		hands.append(h)

	link = HandLink.new(host)


func _process(delta: float) -> void:
	var now := Time.get_ticks_usec()
	_head_hist.append([now, cam.global_transform])
	while _head_hist.size() > 2 and now - _head_hist[0][0] > 1_000_000:
		_head_hist.pop_front()

	link.poll()
	for i in 2:
		_update_hand(hands[i], link.hands[i], now)

	_status_t -= delta
	if _status_t <= 0.0:
		_status_t = 0.2
		_update_status()

	if _screenshot != "" and Time.get_ticks_msec() > _screenshot_ms:
		get_viewport().get_texture().get_image().save_png(_screenshot)
		print("saved ", _screenshot)
		get_tree().quit()


func _update_hand(h: HandState, s: HandLink.HandSample, now: int) -> void:
	h.tracked = s.valid and now - s.capture_usec < STALE_USEC
	if not h.tracked:
		h.view.visible = false
		h.ray.visible = false
		h.cursor.visible = false
		if h.fist:
			_release(h)
		return

	# Place the hand with the head pose from when the camera saw it, so hands
	# stay put in the world while you turn your head.
	var head := _head_at(s.capture_usec)
	h.world = head * Transform3D(Basis(s.rot), s.pos)
	h.view.global_transform = h.world
	h.view.set_curls(s.curls)
	h.view.visible = true

	var mean := (s.curls[1] + s.curls[2] + s.curls[3] + s.curls[4]) / 4.0
	var was_fist := h.fist
	h.fist = mean > FIST_ON if not h.fist else mean > FIST_OFF

	# Pointer ray straight out along the fingers from the palm.
	var from := h.world.origin
	var dir := (-h.world.basis.z).normalized()
	var hit := {}
	if h.grabbed == null:
		var q := PhysicsRayQueryParameters3D.create(from + dir * 0.05, from + dir * RAY_LEN)
		hit = get_world_3d().direct_space_state.intersect_ray(q)
	var end := from + dir * RAY_LEN
	h.hover = null
	if h.grabbed != null:
		end = from + dir * h.grab_dist
	elif not hit.is_empty():
		end = hit.position
		h.hover = hit.collider
	_place_ray(h.ray, from, end)
	h.ray.material_override = _ray_mat_fist if h.fist else _ray_mat_idle
	h.ray.visible = true
	h.cursor.global_position = end
	h.cursor.visible = h.grabbed == null and not hit.is_empty()

	if h.fist and not was_fist:
		_press(h)
	elif not h.fist and was_fist:
		_release(h)
	if h.grabbed != null:
		h.grabbed.global_position = from + dir * h.grab_dist + h.grab_offset


func _press(h: HandState) -> void:
	if h.hover == null:
		return
	match str(h.hover.get_meta("kind", "")):
		"button":
			_clicks += 1
			print("%s hand clicked a button (%d clicks)" % [h.side, _clicks])
			_color_shift += 1
			_flash(h.hover)
			for i in _cubes.size():
				_set_color(_cubes[i], PALETTE[(i + _color_shift) % PALETTE.size()])
		"cube":
			h.grabbed = h.hover
			print("%s hand grabbed a block" % h.side)
			var from := h.world.origin
			h.grab_dist = from.distance_to(h.grabbed.global_position)
			h.grab_offset = Vector3.ZERO


func _release(h: HandState) -> void:
	h.grabbed = null
	h.fist = false


## Interpolated head pose at a past time (from the recent history).
func _head_at(usec: int) -> Transform3D:
	var n := _head_hist.size()
	if n == 0:
		return cam.global_transform
	if usec <= _head_hist[0][0]:
		return _head_hist[0][1]
	for i in range(n - 1, 0, -1):
		var a = _head_hist[i - 1]
		var b = _head_hist[i]
		if usec >= a[0]:
			var span := float(b[0] - a[0])
			var t := 0.0 if span <= 0.0 else clampf((usec - a[0]) / span, 0.0, 1.0)
			return (a[1] as Transform3D).interpolate_with(b[1], t)
	return _head_hist[n - 1][1]


func _update_status() -> void:
	var since := link.seconds_since_packet()
	var lines := PackedStringArray()
	lines.append("Frame Hands · " + build_info)
	if since == INF:
		lines.append("Waiting for the hand tracker on UDP %d…" % HandLink.PORT)
		lines.append("Is it running? (~/handtrack/start.sh or the Hand Tracking panel)")
	elif since > 1.0:
		lines.append("Hand tracker silent for %.0f s" % since)
	else:
		lines.append("Tracker connected · %d packets" % link.packets)
	for h in hands:
		var t := "—"
		if h.tracked:
			t = "FIST" if h.fist else "open"
			if h.grabbed:
				t += " (holding)"
		lines.append("%s: %s" % [h.side.capitalize(), t])
	lines.append("Point at a button and make a fist to click · fist on a block to grab · clicks: %d" % _clicks)
	status.text = "\n".join(lines)


func _build_world() -> void:
	var env := WorldEnvironment.new()
	var e := Environment.new()
	e.background_mode = Environment.BG_COLOR
	e.background_color = Color("1b2030")
	e.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	e.ambient_light_color = Color("8090b0")
	e.ambient_light_energy = 0.7
	env.environment = e
	add_child(env)

	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-55, -30, 0)
	sun.light_energy = 1.2
	add_child(sun)

	_box(Vector3(6, 0.02, 6), Vector3(0, -0.01, 0), Color("3a3d46"))                 # floor
	_box(Vector3(1.0, 0.04, 0.55), Vector3(0, 0.76, -0.6), Color("8b6b4a"))          # table
	_box(Vector3(1.2, 0.7, 0.03), Vector3(0, 1.35, -1.25), Color("2b3245"))          # button board

	for i in 3:
		var b := _body(Vector3(0.26, 0.18, 0.04), Vector3(-0.32 + i * 0.32, 1.35, -1.215), Color("e8453c"))
		b.set_meta("kind", "button")
	for i in 4:
		var c := _body(Vector3(0.08, 0.08, 0.08), Vector3(-0.3 + i * 0.2, 0.82, -0.55), PALETTE[i])
		c.set_meta("kind", "cube")
		_cubes.append(c)

	status = Label3D.new()
	status.font_size = 36
	status.pixel_size = 0.0011
	status.outline_size = 8
	status.position = Vector3(0, 1.85, -1.24)
	status.width = 1100
	status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	status.text = "Frame Hands"
	add_child(status)


func _box(size: Vector3, pos: Vector3, color: Color) -> MeshInstance3D:
	var m := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	m.mesh = bm
	m.material_override = _lit(color)
	m.position = pos
	add_child(m)
	return m


## A box you can point at (has a collision shape).
func _body(size: Vector3, pos: Vector3, color: Color) -> StaticBody3D:
	var body := StaticBody3D.new()
	body.position = pos
	var shape := CollisionShape3D.new()
	var bs := BoxShape3D.new()
	bs.size = size
	shape.shape = bs
	body.add_child(shape)
	var m := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	m.mesh = bm
	m.material_override = _lit(color)
	m.name = "Mesh"
	body.add_child(m)
	add_child(body)
	return body


func _set_color(body: Node3D, color: Color) -> void:
	(body.get_node("Mesh") as MeshInstance3D).material_override = _lit(color)


func _flash(body: Node3D) -> void:
	_set_color(body, Color("ffffff"))
	var tw := create_tween()
	tw.tween_interval(0.15)
	tw.tween_callback(_set_color.bind(body, Color("e8453c")))


func _place_ray(m: MeshInstance3D, a: Vector3, b: Vector3) -> void:
	var d := b - a
	var len := d.length()
	if len < 1e-4:
		m.visible = false
		return
	var y := d / len
	var x := y.cross(Vector3.FORWARD if absf(y.z) < 0.9 else Vector3.RIGHT).normalized()
	var z := x.cross(y)
	m.global_transform = Transform3D(Basis(x, y * len, z), (a + b) * 0.5)


static func _lit(c: Color) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = c
	m.roughness = 0.6
	return m


static func _unshaded(c: Color) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = c
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	if c.a < 1.0:
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	return m
