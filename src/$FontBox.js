// @ts-check
/* global localize, text_tool_font */
import { $ToolWindow } from "./$ToolWindow.js";
// import { localize } from "./app-localization.js";
import { $G, E, supports_vertical_writing_mode } from "./helpers.js";

// 2draw: fonts are found with FontDetective (measuring common fonts; no permission needed).
// The Local Font Access API (window.queryLocalFonts) shows a permission prompt, so it's only used
// when the user picks "More fonts…" in the dropdown (see below), never automatically.
const eachFont = (callback, afterAllCallback) => {
	FontDetective.each(callback);
	FontDetective.all(afterAllCallback);
};

/**
 * Lists the fonts installed on the system with the Local Font Access API. Needs a user gesture (shows a prompt).
 * @returns {Promise<{ name: string, toString(): string }[]>}
 */
async function queryLocalFontFamilies() {
	const availableFonts = await window.queryLocalFonts();
	const familyNames = new Set();
	const fonts = [];
	for (const font of availableFonts) {
		if (familyNames.has(font.family)) {
			continue;
		}
		familyNames.add(font.family);
		fonts.push({
			name: font.family,
			toString() {
				return '"' + this.name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + '"';
			},
		});
	}
	return fonts;
}

const MORE_FONTS_VALUE = "more-fonts"; // (real values are quoted family names)

/**
 * @returns {OSGUI$Window}
 */
function $FontBox() {
	const $fb = $(E("div")).addClass("font-box");

	// This complex cast tells it that jQuery's val() method can return a string and not an array of strings.
	// See the types for val().
	const $family = /** @type {JQuery<HTMLSelectElement & { type: "select-one" }>} */(
		$(E("select")).addClass("inset-deep").attr({
			"aria-label": "Font Family",
			"aria-description": localize("Selects the font used by the text."),
		})
	);
	const $size = $(E("input")).addClass("inset-deep").attr({
		type: "number",
		min: 8,
		max: 72,
		value: text_tool_font.size,
		"aria-label": "Font Size",
		"aria-description": localize("Selects the point size of the text."),
	}).css({
		maxWidth: 50,
	});
	const $button_group = $(E("span")).addClass("text-toolbar-button-group");
	// @TODO: localized labels
	const $bold = $Toggle(0, "bold", "Bold", localize("Sets or clears the text bold attribute."));
	const $italic = $Toggle(1, "italic", "Italic", localize("Sets or clears the text italic attribute."));
	const $underline = $Toggle(2, "underline", "Underline", localize("Sets or clears the text underline attribute."));
	// The original text from MS Paint is simply not true: browsers that support vertical writing also work with Latin text
	// However, vertical-lr is a bit weird for Latin text.
	// const $vertical = $Toggle(3, "vertical", "Vertical Writing Mode", localize("Only a Far East font can be used for vertical editing."));
	// So alternate text, which we won't have translations for...
	const $vertical = $Toggle(3, "vertical", "Vertical Writing Mode", localize("Vertical writing is intended for Far East scripts."));
	// const $vertical = $Toggle(3, "vertical", "Vertical Writing Mode", localize("Vertical writing works best with Far East scripts."));
	$vertical.prop("disabled", !supports_vertical_writing_mode());

	$button_group.append($bold, $italic, $underline, $vertical);
	$fb.append($family, $size, $button_group);

	const update_font = () => {
		text_tool_font.size = Number($size.val());
		text_tool_font.family = $family.val();
		$G.trigger("option-changed");
	};

	const originalFamily = text_tool_font.family;
	const add_font_option = (font) => {
		if ($family.children("option").filter((_i, el) => el.value === String(font)).length) {
			return;
		}
		const $option = $(E("option"));
		$option.val(font).text(font.name);
		// Insert in alphabetical order
		const $options = $family.children("option");
		let i = 0;
		for (; i < $options.length; i++) {
			if ($options.eq(i).text().localeCompare(font.name) > 0) {
				break;
			}
		}
		if ($options.eq(i).length) {
			$options.eq(i).before($option);
		} else {
			$family.append($option);
		}
		$family.append($more_fonts); // keep "More fonts…" last
		// Select the first known-available font, just in case FontDetective.each is slow.
		if (!text_tool_font.family) {
			update_font();
		}
	};
	// "More fonts…": the full system font list, asked for only when chosen (it shows a permission prompt)
	let $more_fonts = $();
	if (window.queryLocalFonts) {
		$more_fonts = $(E("option")).val(MORE_FONTS_VALUE).text("More fonts…");
		$family.append($more_fonts);
	}
	eachFont(add_font_option, () => {
		// All fonts have been added to the list. Now we can select the default font.
		$family.val(originalFamily);
		// Liberation Sans is designed to be metrically compatible with Arial,
		// and is available in free operating systems like Ubuntu.
		if (!$family.val()) {
			$family.val('"Liberation Sans"');
		}
		// Fallback to the first font in the list. At least it's something.
		if (!$family.val()) {
			$family.val($family.children("option").eq(0).val());
		}
		update_font();
	});

	if (text_tool_font.family) {
		$family.val(text_tool_font.family);
	}

	let family_before_more = text_tool_font.family;
	$family.on("change", async () => {
		if ($family.val() !== MORE_FONTS_VALUE) {
			family_before_more = $family.val();
			update_font();
			return;
		}
		$family.val(family_before_more);
		try {
			const fonts = await queryLocalFontFamilies();
			for (const font of fonts) {
				add_font_option(font);
			}
			$more_fonts.remove();
		} catch (error) {
			console.log("queryLocalFonts failed:", error);
		}
		$family.val(family_before_more);
	});
	$size.on("change", update_font);

	const $w = $ToolWindow();
	$w.title(localize("Fonts"));
	$w.$content.append($fb);
	$w.center();

	// Hotfix for bug where the font dropdown would close immediately when clicked in Chrome.
	// Code in $Window.js (from os-gui.js but PATCHED) is trying to focus the dropdown when it's already focused,
	// or focusing the window content area. Either can cause the dropdown to close.
	// The code patches in $Window.js specific to this repo may be related to why this is happening.
	// See: "PATCHED; I want focus tracking in a tool window"
	// Maybe I don't want it for the font window! (What tool window did I want it for? A history panel, or...?)
	// I could probably adjust my patch to not apply to the font box, but this is a quick fix.
	$family[0].focus = () => {
		// console.trace("$FontBox: Font family select focus() called");
	};
	$w.$content[0].focus = () => {
		// console.trace("$FontBox: Font box window content area focus() called");
	};

	return $w;


	function $Toggle(xi, thing, label, description) {
		const $button = $(E("button")).addClass("toggle").attr({
			"aria-pressed": false,
			"aria-label": label,
			"aria-description": description,
		});
		const $icon = $(E("span")).addClass("icon").appendTo($button);
		$button.css({
			width: 23,
			height: 22,
			padding: 0,
			display: "inline-flex",
			alignContent: "center",
			alignItems: "center",
			justifyContent: "center",
		});
		$icon.css({
			flex: "0 0 auto",
			display: "block",
			width: 16,
			height: 16,
			"--icon-index": xi,
		});
		$button.on("click", () => {
			$button.toggleClass("selected");
			text_tool_font[thing] = $button.hasClass("selected");
			$button.attr("aria-pressed", $button.hasClass("selected") ? "true" : "false");
			update_font();
		});
		if (text_tool_font[thing]) {
			$button.addClass("selected").attr("aria-pressed", "true");
		}
		return $button;
	}
}

export { $FontBox };

