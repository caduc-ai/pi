/**
 * Render text as a scannable QR code for the terminal, using half-block
 * characters with explicit black/white colors (two modules per row, 2-module
 * quiet zone).
 */

import chalk from "chalk";
import qrcode from "qrcode-generator";

const QUIET_ZONE = 2;

export function renderQrCodeLines(text: string): string[] {
	const qr = qrcode(0, "M"); // type 0 = auto-detect size
	qr.addData(text);
	qr.make();
	const size = qr.getModuleCount();

	const isDark = (row: number, col: number): boolean => {
		if (row < 0 || col < 0 || row >= size || col >= size) return false;
		return qr.isDark(row, col);
	};

	const lines: string[] = [];
	for (let row = -QUIET_ZONE; row < size + QUIET_ZONE; row += 2) {
		let line = "";
		for (let col = -QUIET_ZONE; col < size + QUIET_ZONE; col++) {
			const top = isDark(row, col);
			const bottom = isDark(row + 1, col);
			line += chalk.bgHex(bottom ? "#000000" : "#ffffff").hex(top ? "#000000" : "#ffffff")("▀");
		}
		lines.push(line);
	}
	return lines;
}
