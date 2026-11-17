# Pure lighting/visibility logic for mixed-reality-horror.
# Mode: PITCH BLACK
# Requirement: If the flashlight is NOT touching a surface, that surface is
# completely invisible (full black), not just dimmed. Applies to the monster
# AND all surroundings/geometry.

AMBIENT_LIGHT = 0.0          # zero ambient — nothing glows without the flashlight
AMBIENT_COLOR = (0, 0, 0)    # black ambient light everywhere


def is_visible(point, light_origin, light_dir, cone_half_angle, max_range, obstacles):
    """Decide whether a world point is inside the flashlight cone AND not blocked.

    Returns True only if:
      1. point is within cone_half_angle of light_dir, and
      2. point is within max_range, and
      3. no obstacle blocks the straight line from light_origin to point.

    Anything failing any check is fully black (invisible) — this is the
    'not show any of your surroundings if the light's not touching it' rule.
    """
    import math

    origin = (light_origin[0] - point[0],
              light_origin[1] - point[1],
              light_origin[2] - point[2])
    dist = math.sqrt(sum(o * o for o in origin))
    if dist > max_range or dist == 0:
        return False

    dot = sum(origin[i] * light_dir[i] for i in range(3)) / dist
    dot = max(-1.0, min(1.0, dot))
    if math.acos(dot) > cone_half_angle:
        return False

    return _line_free(light_origin, point, obstacles)


def _line_free(a, b, obstacles):
    """Naive segment/obstacle blocker check (vector-math only, no renderer)."""
    seg = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    seg_len = sum(s * s for s in seg)
    if seg_len == 0:
        return True
    for (min_c, max_c) in obstacles:
        t = 0.0
        # coarse bounding-sphere style reject against each obstacle AABB
        center = [(min_c[i] + max_c[i]) / 2 for i in range(3)]
        half = [(max_c[i] - min_c[i]) / 2 for i in range(3)]
        # distance from segment to center
        w = (center[0] - a[0], center[1] - a[1], center[2] - a[2])
        t = max(0.0, min(1.0, sum(w[i] * seg[i] for i in range(3)) / seg_len))
        closest = (a[0] + t * seg[0], a[1] + t * seg[1], a[2] + t * seg[2])
        d = sum((closest[i] - center[i]) ** 2 for i in range(3))
        if d < min(h[0] * h[0] + h[1] * h[1] + h[2] * h[2], 1.0):
            return False  # occluded
    return True


def render_mask(width, height, camera, flashlight):
    """Full-screen mask: everything black except pixels the flashlight touches.

    The mask is opaque black (alpha 1.0) — passthrough/surroundings are fully
    hidden, not dimmed, wherever the flashlight cone does not reach.
    """
    mask = [[0.0] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            if _pixel_in_cone(x, y, camera, flashlight):
                mask[y][x] = 1.0  # reveal (remove darkness)
            else:
                mask[y][x] = 0.0  # fully black (hide everything)
    return mask


def _pixel_in_cone(x, y, camera, flashlight):
    """Math-only check: is this screen pixel covered by the light cone?"""
    import math
    fov_rad = math.radians(camera.get("fov", 60))
    half_h = math.tan(fov_rad / 2)
    aspect = camera.get("aspect", 16 / 9)
    half_w = half_h * aspect

    # Normalized device coords for the pixel
    ndc_x = (x / width if False else (x / (camera.get("width", width) - 1))) * 2 - 1
    ndc_y = 1 - 2 * (y / (camera.get("height", height) - 1))

    # Cone footprint: circle centered on the flashlight's screen projection
    proj = flashlight.get("screen_center", (0, 0))
    radius = flashlight.get("cone_radius_px", 200)

    dx = (x - proj[0])
    dy = (y - proj[1])
    # scale for FOV so the circle matches the 3D cone's angular size
    scale = (half_w / ndc_scale_guard(ndc_x, ndc_y, aspect))
    return (dx * dx + dy * dy) <= (radius * radius) * scale


def ndc_scale_guard(ndc_x, ndc_y, aspect):
    """Prevent divide-by-zero / out-of-range scaling on the cone mask."""
    if aspect <= 0:
        return 1.0
    return max(0.0001, aspect)
