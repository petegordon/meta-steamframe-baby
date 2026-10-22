class_name HandView
extends Node3D
## A simple joints-and-bones hand built from what the tracker sends:
## the palm pose plus how curled each finger is (it doesn't send full joints).
## Local frame = palm frame: -z along the fingers, +y out of the back of the hand.

const SEG_RADIUS := 0.007
const JOINT_RADIUS := 0.009
# Right-hand layout (x is mirrored for the left hand). Knuckle positions, metres.
const KNUCKLES := [
	Vector3(-0.030, -0.005, 0.025),   # thumb base
	Vector3(-0.024, 0.0, -0.040),     # index
	Vector3(-0.008, 0.0, -0.043),     # middle
	Vector3(0.008, 0.0, -0.040),      # ring
	Vector3(0.023, 0.0, -0.034),      # pinky
]
const LENGTHS := [
	[0.040, 0.032, 0.026],
	[0.040, 0.025, 0.020],
	[0.045, 0.028, 0.022],
	[0.042, 0.026, 0.020],
	[0.033, 0.020, 0.018],
]
# Bend per segment (degrees) at curl = 1.
const FLEX := [
	[25.0, 45.0, 45.0],
	[85.0, 100.0, 60.0],
	[85.0, 100.0, 60.0],
	[85.0, 100.0, 60.0],
	[85.0, 100.0, 60.0],
]

var side := "right"
var _joints: Array[MeshInstance3D] = []
var _bones: Array[MeshInstance3D] = []
var _palm: MeshInstance3D


func setup(hand_side: String, color: Color) -> void:
	side = hand_side
	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	mat.emission_enabled = true
	mat.emission = color * 0.35
	mat.roughness = 0.5
	var sphere := SphereMesh.new()
	sphere.radius = JOINT_RADIUS
	sphere.height = JOINT_RADIUS * 2
	sphere.radial_segments = 12
	sphere.rings = 6
	var cyl := CylinderMesh.new()
	cyl.top_radius = SEG_RADIUS
	cyl.bottom_radius = SEG_RADIUS
	cyl.height = 1.0
	cyl.radial_segments = 8
	cyl.rings = 1
	for f in 5:
		for k in 4:
			var j := MeshInstance3D.new()
			j.mesh = sphere
			j.material_override = mat
			add_child(j)
			_joints.append(j)
		for k in 3:
			var b := MeshInstance3D.new()
			b.mesh = cyl
			b.material_override = mat
			add_child(b)
			_bones.append(b)
	_palm = MeshInstance3D.new()
	var box := BoxMesh.new()
	box.size = Vector3(0.062, 0.014, 0.075)
	_palm.mesh = box
	_palm.material_override = mat
	_palm.position = Vector3(0, 0, 0.0)
	add_child(_palm)
	visible = false


## curls: thumb..pinky, 0 open .. 1 fully curled.
func set_curls(curls: PackedFloat32Array) -> void:
	var mirror := -1.0 if side == "left" else 1.0
	for f in 5:
		var base: Vector3 = KNUCKLES[f]
		base.x *= mirror
		var dir: Vector3
		var toward: Vector3  # direction the finger bends toward
		if f == 0:
			dir = Vector3(-0.45 * mirror, -0.2, -0.85).normalized()
			toward = Vector3(0.8 * mirror, -0.6, 0.0).normalized()
		else:
			dir = Vector3(0, 0, -1)
			toward = Vector3(0, -1, 0)
		var axis := dir.cross(toward).normalized()
		var c := clampf(curls[f], 0.0, 1.0)
		var p := base
		_joints[f * 4].position = p
		for k in 3:
			dir = dir.rotated(axis, deg_to_rad(FLEX[f][k] * c))
			var q: Vector3 = p + dir * LENGTHS[f][k]
			_place_bone(_bones[f * 3 + k], p, q)
			_joints[f * 4 + k + 1].position = q
			p = q


static func _place_bone(m: MeshInstance3D, a: Vector3, b: Vector3) -> void:
	var d := b - a
	var len := d.length()
	if len < 1e-5:
		m.visible = false
		return
	m.visible = true
	var y := d / len
	var x := y.cross(Vector3.FORWARD if absf(y.z) < 0.9 else Vector3.RIGHT).normalized()
	var z := x.cross(y)
	m.transform = Transform3D(Basis(x, y * len, z), (a + b) * 0.5)
