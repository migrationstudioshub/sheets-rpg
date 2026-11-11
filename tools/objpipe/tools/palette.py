"""Dead-world palette: 41 colours, dark and desaturated, with blood and rust accents.

Ramps run dark -> light. Light comes from the top-left of the unflipped sprite.
"""

RAMPS = {
    # outline + neutrals (outline is near-black, never pure #000)
    "ink":    ["#0e0d11", "#1c1b21", "#2c2a31", "#423f46", "#5e5a60", "#837d7f", "#ada59f", "#d8cfc2"],
    # warm greys: hair, stubble, grime
    "grime":  ["#2f2925", "#4a413b", "#6c6058"],
    # living skin
    "skin":   ["#3a241d", "#5f3b2c", "#8b5a41", "#b5835f", "#d6aa83"],
    # weathered / pale skin (desaturated)
    "pale":   ["#4b3b34", "#776256", "#a38b7a", "#c8b19d"],
    # dead flesh (zombies)
    "rot":    ["#262c22", "#3c4633", "#586546", "#7c8862", "#a2a683"],
    # blood
    "blood":  ["#2d090c", "#5a1118", "#8e1c22", "#c1352d"],
    # rust / leather / wood
    "rust":   ["#38251a", "#5b3923", "#88582f", "#b0793b"],
    # olive drab cloth
    "drab":   ["#272a1f", "#3e4331", "#5d6447"],
    # cold denim / steel blue
    "cold":   ["#1e2532", "#333f58", "#536884"],
    # accents
    "accent": ["#c49b2a", "#e7ddc2"],   # hazard yellow, bone
}

PALETTE_HEX = [c for ramp in RAMPS.values() for c in ramp]
PALETTE = [tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) for h in PALETTE_HEX]
OUTLINE = PALETTE[0]

assert len(PALETTE) == 41, len(PALETTE)

# Tint presets for tintable clothing: 4 shades each, dark -> light.
# A tint mask stores shade 0-3 per pixel; the engine swaps in one of these ramps.
TINTS = {
    "black":    ["#141318", "#25232a", "#38353d", "#524e56"],
    "charcoal": ["#2c2a31", "#423f46", "#5e5a60", "#837d7f"],
    "navy":     ["#161c2a", "#1e2532", "#333f58", "#536884"],
    "olive":    ["#272a1f", "#3e4331", "#5d6447", "#7c8862"],
    "khaki":    ["#4a4230", "#6b5f43", "#8f805a", "#b3a276"],
    "brown":    ["#38251a", "#5b3923", "#88582f", "#b0793b"],
    "maroon":   ["#2d090c", "#5a1118", "#8e1c22", "#c1352d"],
    "bone":     ["#6c6058", "#ada59f", "#d8cfc2", "#e7ddc2"],
    "hazard":   ["#4d3d12", "#7d6418", "#c49b2a", "#dcc05a"],
    # hair colours
    "hair_black":  ["#100e12", "#1d1a1f", "#2e2a30", "#46404a"],
    "hair_dark":   ["#1e1410", "#33221a", "#4d3426", "#6b4b37"],
    "hair_brown":  ["#2e1d13", "#4f321f", "#77502f", "#9c7044"],
    "hair_auburn": ["#2e1210", "#5a2219", "#873a22", "#b05a2e"],
    "hair_ginger": ["#4a1f0e", "#7d3a15", "#b5601f", "#d98a3a"],
    "hair_blonde": ["#5a4526", "#8a6d3b", "#b8975a", "#dcc28a"],
    "hair_grey":   ["#3a3739", "#5f5b5c", "#8c8686", "#b9b2ad"],
    "hair_white":  ["#6e6865", "#a39c97", "#cfc8c0", "#ece6dc"],
}
