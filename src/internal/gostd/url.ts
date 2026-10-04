// Copyright 2009 The Go Authors. All rights reserved. (url.go, path.go)
// Copyright 2020 The Go Authors. All rights reserved. (netip.go)
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in LICENSES/BSD-3-Clause-Go.txt.
//
// Ported from net/url/url.go, net/netip/netip.go and path/path.go (Go standard library)
// @ Go 1.25.5 (url.Parse, URL.JoinPath and URL.String, with what they call: netip.ParseAddr's
// validation, path.Join and path.Clean)
//
// This file is not a port of a Tessera file. Tessera's witness.go reads each witness URL of a
// policy with `url.Parse`, joins `/add-checkpoint` onto it with `(*url.URL).JoinPath`, and
// keeps the endpoint as `(*url.URL).String()`. The platform `URL` type is no stand-in for any
// of the three: it follows the WHATWG URL Standard, which accepts and rejects different
// strings (relative references, a port above 65535, an IPv6 zone, a host with `<` in it),
// normalises what it keeps (the host's case, a default port, dot segments) and escapes
// differently. So the subset witness.go needs is transcribed here, error texts included, and
// src/witness.ts reaches Go's verdict, error and endpoint for every policy URL. See
// docs/decisions/0241-witness-policy-urls-parsed-as-go-parses-them.md.
//
// Port note: a Go string is a sequence of bytes, and every index, length and comparison in
// these functions is a byte's. So the functions below work on "byte strings": JavaScript
// strings that hold one byte per UTF-16 code unit (each code unit 0 to 255). {@link parse}
// takes an ordinary string and encodes it to UTF-8 first; {@link URL.string} decodes its
// result back; error messages quote the bytes as Go's %q does (strconv.quoteBytes), so a
// slice cut inside a character reads `\xNN` exactly as in Go. Fields of {@link URL} are byte
// strings.
//
// Port note: what is not here has no caller: `ParseRequestURI` (so `parse` has no viaRequest
// parameter), the query and path escaping functions, `Values`, `ResolveReference`, `Redacted`,
// the `Hostname` and `Port` accessors, and the marshalling methods.

import { fromUTF8, toUTF8 } from "./bytes.ts";
import { quoteBytes } from "./strconv.ts";
import { cut } from "./strings.ts";

/** byteString returns the UTF-8 encoding of s as a byte string (see the header). */
function byteString(s: string): string {
	const b = toUTF8(s);
	let out = "";
	for (let i = 0; i < b.length; i += 0x2000) {
		out += String.fromCharCode(...b.subarray(i, i + 0x2000));
	}
	return out;
}

/** bytesOf returns the bytes a byte string holds. */
function bytesOf(bs: string): Uint8Array {
	const b = new Uint8Array(bs.length);
	for (let i = 0; i < bs.length; i++) {
		b[i] = bs.charCodeAt(i);
	}
	return b;
}

/** q is Go's `%q` (strconv.Quote) of the bytes a byte string holds. */
function q(bs: string): string {
	return quoteBytes(bytesOf(bs));
}

/**
 * URLError reports an error and the operation and URL that caused it.
 *
 * Port note: Go's `url.Error`, renamed because `Error` is JavaScript's own error class. Op,
 * URL and Err are camelCased fields; the URL is a byte string. The message is Go's
 * `fmt.Sprintf("%s %q: %s", e.Op, e.URL, e.Err)`, and Err is also the cause, as Unwrap
 * returns it.
 */
export class URLError extends Error {
	readonly op: string;
	readonly url: string;
	readonly err: Error;

	constructor(op: string, url: string, err: Error) {
		super(`${op} ${q(url)}: ${err.message}`, { cause: err });
		this.name = "URLError";
		this.op = op;
		this.url = url;
		this.err = err;
	}
}

const upperhex = "0123456789ABCDEF";

function ishex(c: number): boolean {
	return (0x30 <= c && c <= 0x39) || (0x61 <= c && c <= 0x66) || (0x41 <= c && c <= 0x46);
}

function unhex(c: number): number {
	if (0x30 <= c && c <= 0x39) {
		return c - 0x30;
	}
	if (0x61 <= c && c <= 0x66) {
		return c - 0x61 + 10;
	}
	if (0x41 <= c && c <= 0x46) {
		return c - 0x41 + 10;
	}
	throw new Error("invalid hex character");
}

const encodePath = 1;
const encodePathSegment = 2;
const encodeHost = 3;
const encodeZone = 4;
const encodeUserPassword = 5;
const encodeQueryComponent = 6;
const encodeFragment = 7;
type encoding = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** EscapeError reports a malformed percent-escape; s is a byte string. */
export class EscapeError extends Error {
	constructor(s: string) {
		super(`invalid URL escape ${q(s)}`);
		this.name = "EscapeError";
	}
}

/** InvalidHostError reports a byte a host may not hold; s is a byte string. */
export class InvalidHostError extends Error {
	constructor(s: string) {
		super(`invalid character ${q(s)} in host name`);
		this.name = "InvalidHostError";
	}
}

/**
 * Return true if the specified character should be escaped when
 * appearing in a URL string, according to RFC 3986.
 *
 * Please be informed that for now shouldEscape does not check all
 * reserved characters correctly. See golang.org/issue/5684.
 */
function shouldEscape(c: number, mode: encoding): boolean {
	// §2.3 Unreserved characters (alphanum)
	if ((0x61 <= c && c <= 0x7a) || (0x41 <= c && c <= 0x5a) || (0x30 <= c && c <= 0x39)) {
		return false;
	}

	if (mode === encodeHost || mode === encodeZone) {
		// §3.2.2 Host allows
		//	sub-delims = "!" / "$" / "&" / "'" / "(" / ")" / "*" / "+" / "," / ";" / "="
		// as part of reg-name.
		// We add : because we include :port as part of host.
		// We add [ ] because we include [ipv6]:port as part of host.
		// We add < > because they're the only characters left that
		// we could possibly allow, and Parse will reject them if we
		// escape them (because hosts can't use %-encoding for
		// ASCII bytes).
		switch (String.fromCharCode(c)) {
			case "!":
			case "$":
			case "&":
			case "'":
			case "(":
			case ")":
			case "*":
			case "+":
			case ",":
			case ";":
			case "=":
			case ":":
			case "[":
			case "]":
			case "<":
			case ">":
			case '"':
				return false;
		}
	}

	switch (String.fromCharCode(c)) {
		case "-":
		case "_":
		case ".":
		case "~": // §2.3 Unreserved characters (mark)
			return false;

		case "$":
		case "&":
		case "+":
		case ",":
		case "/":
		case ":":
		case ";":
		case "=":
		case "?":
		case "@": // §2.2 Reserved characters (reserved)
			// Different sections of the URL allow a few of
			// the reserved characters to appear unescaped.
			switch (mode) {
				case encodePath: // §3.3
					// The RFC allows : @ & = + $ but saves / ; , for assigning
					// meaning to individual path segments. This package
					// only manipulates the path as a whole, so we allow those
					// last three as well. That leaves only ? to escape.
					return c === 0x3f;

				case encodePathSegment: // §3.3
					// The RFC allows : @ & = + $ but saves / ; , for assigning
					// meaning to individual path segments.
					return c === 0x2f || c === 0x3b || c === 0x2c || c === 0x3f;

				case encodeUserPassword: // §3.2.1
					// The RFC allows ';', ':', '&', '=', '+', '$', and ',' in
					// userinfo, so we must escape only '@', '/', and '?'.
					// The parsing of userinfo treats ':' as special so we must escape
					// that too.
					return c === 0x40 || c === 0x2f || c === 0x3f || c === 0x3a;

				case encodeQueryComponent: // §3.4
					// The RFC reserves (so we must escape) everything.
					return true;

				case encodeFragment: // §4.1
					// The RFC text is silent but the grammar allows
					// everything, so escape nothing.
					return false;

				default:
					// encodeHost and encodeZone fall through to the checks below, as in Go.
					break;
			}
	}

	if (mode === encodeFragment) {
		// RFC 3986 §2.2 allows not escaping sub-delims. A subset of sub-delims are
		// included in reserved from RFC 2396 §2.2. The remaining sub-delims do not
		// need to be escaped. To minimize potential breakage, we apply two restrictions:
		// (1) we always escape sub-delims outside of the fragment, and (2) we always
		// escape single quote to avoid breaking callers that had previously assumed that
		// single quotes would be escaped. See issue #19917.
		switch (String.fromCharCode(c)) {
			case "!":
			case "(":
			case ")":
			case "*":
				return false;
		}
	}

	// Everything else must be escaped.
	return true;
}

/**
 * unescape unescapes a string; the mode specifies
 * which section of the URL string is being unescaped.
 */
// biome-ignore lint/suspicious/noShadowRestrictedNames: the name mirrors Go's net/url unescape; the deprecated global is never used here.
function unescape(s: string, mode: encoding): string {
	// Count %, check that they're well-formed.
	let n = 0;
	let hasPlus = false;
	for (let i = 0; i < s.length; ) {
		const c = s.charCodeAt(i);
		switch (c) {
			case 0x25: // '%'
				n++;
				if (i + 2 >= s.length || !ishex(s.charCodeAt(i + 1)) || !ishex(s.charCodeAt(i + 2))) {
					s = s.slice(i);
					if (s.length > 3) {
						s = s.slice(0, 3);
					}
					throw new EscapeError(s);
				}
				// Per https://tools.ietf.org/html/rfc3986#page-21
				// in the host component %-encoding can only be used
				// for non-ASCII bytes.
				// But https://tools.ietf.org/html/rfc6874#section-2
				// introduces %25 being allowed to escape a percent sign
				// in IPv6 scoped-address literals. Yay.
				if (mode === encodeHost && unhex(s.charCodeAt(i + 1)) < 8 && s.slice(i, i + 3) !== "%25") {
					throw new EscapeError(s.slice(i, i + 3));
				}
				if (mode === encodeZone) {
					// RFC 6874 says basically "anything goes" for zone identifiers
					// and that even non-ASCII can be redundantly escaped,
					// but it seems prudent to restrict %-escaped bytes here to those
					// that are valid host name bytes in their unescaped form.
					// That is, you can use escaping in the zone identifier but not
					// to introduce bytes you couldn't just write directly.
					// But Windows puts spaces here! Yay.
					const v = (unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2));
					if (s.slice(i, i + 3) !== "%25" && v !== 0x20 && shouldEscape(v, encodeHost)) {
						throw new EscapeError(s.slice(i, i + 3));
					}
				}
				i += 3;
				break;
			case 0x2b: // '+'
				hasPlus = mode === encodeQueryComponent;
				i++;
				break;
			default:
				if ((mode === encodeHost || mode === encodeZone) && c < 0x80 && shouldEscape(c, mode)) {
					throw new InvalidHostError(s.slice(i, i + 1));
				}
				i++;
		}
	}

	if (n === 0 && !hasPlus) {
		return s;
	}

	let t = "";
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		switch (c) {
			case 0x25: // '%'
				t += String.fromCharCode((unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2)));
				i += 2;
				break;
			case 0x2b: // '+'
				if (mode === encodeQueryComponent) {
					t += " ";
				} else {
					t += "+";
				}
				break;
			default:
				t += s[i];
		}
	}
	return t;
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: the name mirrors Go's net/url escape; the deprecated global is never used here.
function escape(s: string, mode: encoding): string {
	let spaceCount = 0;
	let hexCount = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (shouldEscape(c, mode)) {
			if (c === 0x20 && mode === encodeQueryComponent) {
				spaceCount++;
			} else {
				hexCount++;
			}
		}
	}

	if (spaceCount === 0 && hexCount === 0) {
		return s;
	}

	let t = "";
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c === 0x20 && mode === encodeQueryComponent) {
			t += "+";
		} else if (shouldEscape(c, mode)) {
			t += `%${upperhex[c >> 4]}${upperhex[c & 15]}`;
		} else {
			t += s[i];
		}
	}
	return t;
}

/**
 * The Userinfo type is an immutable encapsulation of username and
 * password details for a {@link URL}. An existing Userinfo value is guaranteed
 * to have a username set (potentially empty, as allowed by RFC 2396),
 * and optionally a password.
 */
export class Userinfo {
	readonly username: string;
	readonly password: string;
	readonly passwordSet: boolean;

	constructor(username: string, password: string, passwordSet: boolean) {
		this.username = username;
		this.password = password;
		this.passwordSet = passwordSet;
	}

	/**
	 * string returns the encoded userinfo information in the standard form
	 * of "username[:password]".
	 */
	string(): string {
		let s = escape(this.username, encodeUserPassword);
		if (this.passwordSet) {
			s += `:${escape(this.password, encodeUserPassword)}`;
		}
		return s;
	}
}

/**
 * A URL represents a parsed URL (technically, a URI reference).
 *
 * The general form represented is:
 *
 *	[scheme:][//[userinfo@]host][/]path[?query][#fragment]
 *
 * URLs that do not start with a slash after the scheme are interpreted as:
 *
 *	scheme:opaque[?query][#fragment]
 *
 * Note that the Path field is stored in decoded form: /%47%6f%2f becomes /Go/.
 * A consequence is that it is impossible to tell which slashes in the Path were
 * slashes in the raw URL and which were %2f. This distinction is rarely important,
 * but when it is, the code should use the {@link URL.escapedPath} method, which preserves
 * the original encoding of Path.
 *
 * The RawPath field is an optional field which is only set when the default
 * encoding of Path is different from the escaped path. See the EscapedPath method
 * for more details.
 *
 * URL's String method uses the EscapedPath method to obtain the path.
 *
 * Port note: every field is a byte string (see the header); `user` is null where Go's
 * pointer is nil.
 */
export class URL {
	scheme = "";
	opaque = ""; // encoded opaque data
	user: Userinfo | null = null; // username and password information
	host = ""; // host or host:port (see Hostname and Port methods)
	path = ""; // path (relative paths may omit leading slash)
	rawPath = ""; // encoded path hint (see EscapedPath method)
	omitHost = false; // do not emit empty host (authority)
	forceQuery = false; // append a query ('?') even if RawQuery is empty
	rawQuery = ""; // encoded query values, without '?'
	fragment = ""; // fragment for references, without '#'
	rawFragment = ""; // encoded fragment hint (see EscapedFragment method)

	/**
	 * setPath sets the Path and RawPath fields of the URL based on the provided
	 * escaped path p. It maintains the invariant that RawPath is only specified
	 * when it differs from the default encoding of the path.
	 * For example:
	 * - setPath("/foo/bar")   will set Path="/foo/bar" and RawPath=""
	 * - setPath("/foo%2fbar") will set Path="/foo/bar" and RawPath="/foo%2fbar"
	 * setPath will return an error only if the provided path contains an invalid
	 * escaping.
	 */
	setPath(p: string): void {
		const path = unescape(p, encodePath);
		this.path = path;
		if (escape(path, encodePath) === p) {
			// Default encoding is fine.
			this.rawPath = "";
		} else {
			this.rawPath = p;
		}
	}

	/**
	 * escapedPath returns the escaped form of u.Path.
	 * In general there are multiple possible escaped forms of any path.
	 * EscapedPath returns u.RawPath when it is a valid escaping of u.Path.
	 * Otherwise EscapedPath ignores u.RawPath and computes an escaped
	 * form on its own.
	 * The {@link URL.string} method uses EscapedPath to construct its result.
	 * In general, code should call EscapedPath instead of
	 * reading u.RawPath directly.
	 */
	escapedPath(): string {
		if (this.rawPath !== "" && validEncoded(this.rawPath, encodePath)) {
			let p: string | undefined;
			try {
				p = unescape(this.rawPath, encodePath);
			} catch {
				p = undefined;
			}
			if (p === this.path) {
				return this.rawPath;
			}
		}
		if (this.path === "*") {
			return "*"; // don't escape (Issue 11202)
		}
		return escape(this.path, encodePath);
	}

	/** setFragment is like setPath but for Fragment/RawFragment. */
	setFragment(f: string): void {
		const frag = unescape(f, encodeFragment);
		this.fragment = frag;
		if (escape(frag, encodeFragment) === f) {
			// Default encoding is fine.
			this.rawFragment = "";
		} else {
			this.rawFragment = f;
		}
	}

	/**
	 * escapedFragment returns the escaped form of u.Fragment.
	 * In general there are multiple possible escaped forms of any fragment.
	 * EscapedFragment returns u.RawFragment when it is a valid escaping of u.Fragment.
	 * Otherwise EscapedFragment ignores u.RawFragment and computes an escaped
	 * form on its own.
	 * The {@link URL.string} method uses EscapedFragment to construct its result.
	 * In general, code should call EscapedFragment instead of
	 * reading u.RawFragment directly.
	 */
	escapedFragment(): string {
		if (this.rawFragment !== "" && validEncoded(this.rawFragment, encodeFragment)) {
			let f: string | undefined;
			try {
				f = unescape(this.rawFragment, encodeFragment);
			} catch {
				f = undefined;
			}
			if (f === this.fragment) {
				return this.rawFragment;
			}
		}
		return escape(this.fragment, encodeFragment);
	}

	/**
	 * string reassembles the URL into a valid URL string.
	 * The general form of the result is one of:
	 *
	 *	scheme:opaque?query#fragment
	 *	scheme://userinfo@host/path?query#fragment
	 *
	 * If u.Opaque is non-empty, String uses the first form;
	 * otherwise it uses the second form.
	 * Any non-ASCII characters in host are escaped.
	 * To obtain the path, String uses u.EscapedPath().
	 *
	 * In the second form, the following rules apply:
	 *   - if u.Scheme is empty, scheme: is omitted.
	 *   - if u.User is nil, userinfo@ is omitted.
	 *   - if u.Host is empty, host/ is omitted.
	 *   - if u.Scheme and u.Host are empty and u.User is nil,
	 *     the entire scheme://userinfo@host/ is omitted.
	 *   - if u.Host is non-empty and u.Path begins with a /,
	 *     the form host/path does not add its own /.
	 *   - if u.RawQuery is empty, ?query is omitted.
	 *   - if u.Fragment is empty, #fragment is omitted.
	 *
	 * Port note: the result is decoded from UTF-8 into an ordinary string, which is lossless:
	 * everything String escapes is ASCII, and what it copies (the scheme, the opaque data and
	 * the query) is copied from what {@link parse} was given.
	 */
	string(): string {
		let buf = "";
		if (this.scheme !== "") {
			buf += `${this.scheme}:`;
		}
		if (this.opaque !== "") {
			buf += this.opaque;
		} else {
			if (this.scheme !== "" || this.host !== "" || this.user !== null) {
				if (this.omitHost && this.host === "" && this.user === null) {
					// omit empty host
				} else {
					if (this.host !== "" || this.path !== "" || this.user !== null) {
						buf += "//";
					}
					const ui = this.user;
					if (ui !== null) {
						buf += `${ui.string()}@`;
					}
					const h = this.host;
					if (h !== "") {
						buf += escape(h, encodeHost);
					}
				}
			}
			const path = this.escapedPath();
			if (path !== "" && path[0] !== "/" && this.host !== "") {
				buf += "/";
			}
			if (buf.length === 0) {
				// RFC 3986 §4.2
				// A path segment that contains a colon character (e.g., "this:that")
				// cannot be used as the first segment of a relative-path reference, as
				// it would be mistaken for a scheme name. Such a segment must be
				// preceded by a dot-segment (e.g., "./this:that") to make a relative-
				// path reference.
				const [segment] = cut(path, "/");
				if (segment.includes(":")) {
					buf += "./";
				}
			}
			buf += path;
		}
		if (this.forceQuery || this.rawQuery !== "") {
			buf += `?${this.rawQuery}`;
		}
		if (this.fragment !== "") {
			buf += `#${this.escapedFragment()}`;
		}
		return fromUTF8(bytesOf(buf));
	}

	/**
	 * joinPath returns a new URL with the provided path elements joined to
	 * any existing path and the resulting path cleaned of any ./ or ../ elements.
	 * Any sequences of multiple / characters will be reduced to a single /.
	 *
	 * Port note: elem are ordinary strings, encoded to UTF-8 here.
	 */
	joinPath(...elem: string[]): URL {
		const elems = [this.escapedPath(), ...elem.map(byteString)];
		let p: string;
		if (!(elems[0] as string).startsWith("/")) {
			// Return a relative path if u is relative,
			// but ensure that it contains no ../ elements.
			elems[0] = `/${elems[0]}`;
			p = pathJoin(...elems).slice(1);
		} else {
			p = pathJoin(...elems);
		}
		// path.Join will remove any trailing slashes.
		// Preserve at least one.
		if ((elems[elems.length - 1] as string).endsWith("/") && !p.endsWith("/")) {
			p += "/";
		}
		const url = Object.assign(new URL(), this);
		// Port note: Go discards setPath's error here; p is a cleaned EscapedPath, whose
		// escapes are all valid, so it cannot fail.
		url.setPath(p);
		return url;
	}
}

/**
 * Maybe rawURL is of the form scheme:path.
 * (Scheme must be [a-zA-Z][a-zA-Z0-9+.-]*)
 * If so, return scheme, path; else return "", rawURL.
 */
function getScheme(rawURL: string): [scheme: string, path: string] {
	for (let i = 0; i < rawURL.length; i++) {
		const c = rawURL.charCodeAt(i);
		if ((0x61 <= c && c <= 0x7a) || (0x41 <= c && c <= 0x5a)) {
			// do nothing
		} else if ((0x30 <= c && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
			if (i === 0) {
				return ["", rawURL];
			}
		} else if (c === 0x3a) {
			if (i === 0) {
				throw new Error("missing protocol scheme");
			}
			return [rawURL.slice(0, i), rawURL.slice(i + 1)];
		} else {
			// we have encountered an invalid character,
			// so there is no valid scheme
			return ["", rawURL];
		}
	}
	return ["", rawURL];
}

/**
 * parse parses a raw url into a {@link URL} structure.
 *
 * The url may be relative (a path, without a host) or absolute
 * (starting with a scheme). Trying to parse a hostname and path
 * without a scheme is invalid but may not necessarily return an
 * error, due to parsing ambiguities.
 *
 * Port note: Go's `Parse`; it throws a {@link URLError} where Go returns a `*url.Error`.
 */
export function parse(rawURL: string): URL {
	const raw = byteString(rawURL);
	// Cut off #frag
	const [u, frag] = cut(raw, "#");
	let url: URL;
	try {
		url = parseRaw(u);
	} catch (err) {
		throw new URLError("parse", u, err as Error);
	}
	if (frag === "") {
		return url;
	}
	try {
		url.setFragment(frag);
	} catch (err) {
		throw new URLError("parse", raw, err as Error);
	}
	return url;
}

/**
 * parseRaw parses a URL from a string, where all forms of relative URLs are allowed.
 *
 * Port note: Go's unexported `parse`, renamed because `Parse` camelCases to the same name,
 * and without its viaRequest parameter, which only `ParseRequestURI` sets.
 */
function parseRaw(rawURL: string): URL {
	let rest: string;

	if (stringContainsCTLByte(rawURL)) {
		throw new Error("net/url: invalid control character in URL");
	}

	const url = new URL();

	if (rawURL === "*") {
		url.path = "*";
		return url;
	}

	// Split off possible leading "http:", "mailto:", etc.
	// Cannot contain escaped characters.
	[url.scheme, rest] = getScheme(rawURL);
	url.scheme = url.scheme.toLowerCase();

	if (rest.endsWith("?") && rest.indexOf("?") === rest.length - 1) {
		url.forceQuery = true;
		rest = rest.slice(0, -1);
	} else {
		[rest, url.rawQuery] = cut(rest, "?");
	}

	if (!rest.startsWith("/")) {
		if (url.scheme !== "") {
			// We consider rootless paths per RFC 3986 as opaque.
			url.opaque = rest;
			return url;
		}

		// Avoid confusion with malformed schemes, like cache_object:foo/bar.
		// See golang.org/issue/16822.
		//
		// RFC 3986, §3.3:
		// In addition, a URI reference (Section 4.1) may be a relative-path reference,
		// in which case the first path segment cannot contain a colon (":") character.
		const [segment] = cut(rest, "/");
		if (segment.includes(":")) {
			// First path segment has colon. Not allowed in relative URL.
			throw new Error("first path segment in URL cannot contain colon");
		}
	}

	if ((url.scheme !== "" || !rest.startsWith("///")) && rest.startsWith("//")) {
		let authority = rest.slice(2);
		rest = "";
		const i = authority.indexOf("/");
		if (i >= 0) {
			[authority, rest] = [authority.slice(0, i), authority.slice(i)];
		}
		[url.user, url.host] = parseAuthority(authority);
	} else if (url.scheme !== "" && rest.startsWith("/")) {
		// OmitHost is set to true when rawURL has an empty host (authority).
		// See golang.org/issue/46059.
		url.omitHost = true;
	}

	// Set Path and, optionally, RawPath.
	// RawPath is a hint of the encoding of Path. We don't want to set it if
	// the default escaping of Path is equivalent, to help make sure that people
	// don't rely on it in general.
	url.setPath(rest);
	return url;
}

function parseAuthority(authority: string): [user: Userinfo | null, host: string] {
	const i = authority.lastIndexOf("@");
	let host: string;
	if (i < 0) {
		host = parseHost(authority);
	} else {
		host = parseHost(authority.slice(i + 1));
	}
	if (i < 0) {
		return [null, host];
	}
	let userinfo = authority.slice(0, i);
	if (!validUserinfo(userinfo)) {
		throw new Error("net/url: invalid userinfo");
	}
	let user: Userinfo;
	if (!userinfo.includes(":")) {
		userinfo = unescape(userinfo, encodeUserPassword);
		user = new Userinfo(userinfo, "", false);
	} else {
		let [username, password] = cut(userinfo, ":");
		username = unescape(username, encodeUserPassword);
		password = unescape(password, encodeUserPassword);
		user = new Userinfo(username, password, true);
	}
	return [user, host];
}

/**
 * parseHost parses host as an authority without user
 * information. That is, as host[:port].
 */
function parseHost(host: string): string {
	const openBracketIdx = host.lastIndexOf("[");
	if (openBracketIdx !== -1) {
		// Parse an IP-Literal in RFC 3986 and RFC 6874.
		// E.g., "[fe80::1]", "[fe80::1%25en0]", "[fe80::1]:80".
		const closeBracketIdx = host.lastIndexOf("]");
		if (closeBracketIdx < 0) {
			throw new Error("missing ']' in host");
		}

		const colonPort = host.slice(closeBracketIdx + 1);
		if (!validOptionalPort(colonPort)) {
			throw new Error(`invalid port ${q(colonPort)} after host`);
		}
		const unescapedColonPort = unescape(colonPort, encodeHost);

		const hostname = host.slice(openBracketIdx + 1, closeBracketIdx);
		let unescapedHostname: string;
		// RFC 6874 defines that %25 (%-encoded percent) introduces
		// the zone identifier, and the zone identifier can use basically
		// any %-encoding it likes. That's different from the host, which
		// can only %-encode non-ASCII bytes.
		// We do impose some restrictions on the zone, to avoid stupidity
		// like newlines.
		const zoneIdx = hostname.indexOf("%25");
		if (zoneIdx >= 0) {
			const hostPart = unescape(hostname.slice(0, zoneIdx), encodeHost);
			const zonePart = unescape(hostname.slice(zoneIdx), encodeZone);
			unescapedHostname = hostPart + zonePart;
		} else {
			unescapedHostname = unescape(hostname, encodeHost);
		}

		// Per RFC 3986, only a host identified by a valid
		// IPv6 address can be enclosed by square brackets.
		// This excludes any IPv4, but notably not IPv4-mapped addresses.
		let is4: boolean;
		try {
			is4 = parseAddr(unescapedHostname);
		} catch (err) {
			throw new Error(`invalid host: ${(err as Error).message}`, { cause: err });
		}
		if (is4) {
			throw new Error("invalid IP-literal");
		}
		return `[${unescapedHostname}]${unescapedColonPort}`;
	}
	const i = host.lastIndexOf(":");
	if (i !== -1) {
		const colonPort = host.slice(i);
		if (!validOptionalPort(colonPort)) {
			throw new Error(`invalid port ${q(colonPort)} after host`);
		}
	}

	return unescape(host, encodeHost);
}

/**
 * validEncoded reports whether s is a valid encoded path or fragment,
 * according to mode.
 * It must not contain any bytes that require escaping during encoding.
 */
function validEncoded(s: string, mode: encoding): boolean {
	for (let i = 0; i < s.length; i++) {
		// RFC 3986, Appendix A.
		// pchar = unreserved / pct-encoded / sub-delims / ":" / "@".
		// shouldEscape is not quite compliant with the RFC,
		// so we check the sub-delims ourselves and let
		// shouldEscape handle the others.
		switch (s[i]) {
			case "!":
			case "$":
			case "&":
			case "'":
			case "(":
			case ")":
			case "*":
			case "+":
			case ",":
			case ";":
			case "=":
			case ":":
			case "@":
				// ok
				break;
			case "[":
			case "]":
				// ok - not specified in RFC 3986 but left alone by modern browsers
				break;
			case "%":
				// ok - percent encoded, will decode
				break;
			default:
				if (shouldEscape(s.charCodeAt(i), mode)) {
					return false;
				}
		}
	}
	return true;
}

/**
 * validOptionalPort reports whether port is either an empty string
 * or matches /^:\d*$/
 *
 * Port note: Go ranges over the runes of port[1:]; a byte of a multi-byte rune is never an
 * ASCII digit either, so ranging over the bytes gives the same answer.
 */
function validOptionalPort(port: string): boolean {
	if (port === "") {
		return true;
	}
	if (port[0] !== ":") {
		return false;
	}
	for (let i = 1; i < port.length; i++) {
		const b = port.charCodeAt(i);
		if (b < 0x30 || b > 0x39) {
			return false;
		}
	}
	return true;
}

/**
 * validUserinfo reports whether s is a valid userinfo string per RFC 3986
 * Section 3.2.1:
 *
 *	userinfo    = *( unreserved / pct-encoded / sub-delims / ":" )
 *	unreserved  = ALPHA / DIGIT / "-" / "." / "_" / "~"
 *	sub-delims  = "!" / "$" / "&" / "'" / "(" / ")"
 *	              / "*" / "+" / "," / ";" / "="
 *
 * It doesn't validate pct-encoded. The caller does that via func unescape.
 *
 * Port note: as in validOptionalPort, the bytes of a multi-byte rune are rejected one by
 * one where Go rejects the rune.
 */
function validUserinfo(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const r = s.charCodeAt(i);
		if (0x41 <= r && r <= 0x5a) {
			continue;
		}
		if (0x61 <= r && r <= 0x7a) {
			continue;
		}
		if (0x30 <= r && r <= 0x39) {
			continue;
		}
		switch (s[i]) {
			case "-":
			case ".":
			case "_":
			case ":":
			case "~":
			case "!":
			case "$":
			case "&":
			case "'":
			case "(":
			case ")":
			case "*":
			case "+":
			case ",":
			case ";":
			case "=":
			case "%":
				continue;
			case "@":
				// `RFC 3986 section 3.2.1` does not allow '@' in userinfo.
				// It is a delimiter between userinfo and host.
				// However, URLs are diverse, and in some cases,
				// the userinfo may contain an '@' character,
				// for example, in "http://username:p@ssword@google.com",
				// the string "username:p@ssword" should be treated as valid userinfo.
				// Ref:
				//   https://go.dev/issue/3439
				//   https://go.dev/issue/22655
				continue;
			default:
				return false;
		}
	}
	return true;
}

/** stringContainsCTLByte reports whether s contains any ASCII control character. */
function stringContainsCTLByte(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const b = s.charCodeAt(i);
		if (b < 0x20 || b === 0x7f) {
			return true;
		}
	}
	return false;
}

/**
 * parseAddr parses s as an IP address, returning whether it is an IPv4 address (`Is4`).
 * The string s can be in dotted decimal ("192.0.2.1"), IPv6 ("2001:db8::68"),
 * or IPv6 with a scoped addressing zone ("fe80::1cc0:3e8c:119f:c2e1%ens18").
 *
 * Derived from netip (netip.go, `ParseAddr`). Port note: parseHost asks only whether the
 * address parses and whether it is IPv4, so this returns that instead of an Addr.
 */
function parseAddr(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		switch (s[i]) {
			case ".":
				parseIPv4Fields(s, 0, s.length);
				return true;
			case ":":
				parseIPv6(s);
				return false;
			case "%":
				// Assume that this was trying to be an IPv6 address with
				// a zone specifier, but the address is missing.
				throw parseAddrError(s, "missing IPv6 address");
		}
	}
	throw parseAddrError(s, "unable to parse IP");
}

/**
 * parseAddrError is netip's parseAddrError: in is the string given to ParseAddr, msg an
 * explanation of the parse failure and at, optionally, the unparsed portion of in at which
 * the error occurred. Derived from netip (netip.go).
 */
function parseAddrError(input: string, msg: string, at = ""): Error {
	if (at !== "") {
		return new Error(`ParseAddr(${q(input)}): ${msg} (at ${q(at)})`);
	}
	return new Error(`ParseAddr(${q(input)}): ${msg}`);
}

/** parseIPv4Fields validates in[off:end] as dotted decimal. Derived from netip (netip.go). */
function parseIPv4Fields(input: string, off: number, end: number): void {
	let val = 0;
	let pos = 0;
	let digLen = 0; // number of digits in current octet
	const s = input.slice(off, end);
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0x30 && c <= 0x39) {
			if (digLen === 1 && val === 0) {
				throw parseAddrError(input, "IPv4 field has octet with leading zero");
			}
			val = val * 10 + c - 0x30;
			digLen++;
			if (val > 255) {
				throw parseAddrError(input, "IPv4 field has value >255");
			}
		} else if (c === 0x2e) {
			// .1.2.3
			// 1.2.3.
			// 1..2.3
			if (i === 0 || i === s.length - 1 || s[i - 1] === ".") {
				throw parseAddrError(input, "IPv4 field must have at least one digit", s.slice(i));
			}
			// 1.2.3.4.5
			if (pos === 3) {
				throw parseAddrError(input, "IPv4 address too long");
			}
			pos++;
			val = 0;
			digLen = 0;
		} else {
			throw parseAddrError(input, "unexpected character", s.slice(i));
		}
	}
	if (pos < 3) {
		throw parseAddrError(input, "IPv4 address too short");
	}
}

/**
 * parseIPv6 validates in as an IPv6 address (in form "2001:db8::68"). Derived from netip
 * (netip.go).
 *
 * Port note: Go also builds the 16 address bytes; only the validation is needed here, so
 * this counts the bytes the address would fill instead of storing them.
 */
function parseIPv6(input: string): void {
	let s = input;

	// Split off the zone right from the start. Yes it's a second scan
	// of the string, but trying to handle it inline makes a bunch of
	// other inner loop conditionals more expensive, and it ends up
	// being slower.
	let zone = "";
	let i = s.indexOf("%");
	if (i !== -1) {
		[s, zone] = [s.slice(0, i), s.slice(i + 1)];
		if (zone === "") {
			// Not allowed to have an empty zone if explicitly specified.
			throw parseAddrError(input, "zone must be a non-empty string");
		}
	}

	let ellipsis = -1; // position of ellipsis in ip

	// Might have leading ellipsis
	if (s.length >= 2 && s[0] === ":" && s[1] === ":") {
		ellipsis = 0;
		s = s.slice(2);
		// Might be only ellipsis
		if (s.length === 0) {
			return;
		}
	}

	// Loop, parsing hex numbers followed by colon.
	i = 0;
	while (i < 16) {
		// Hex number. Similar to parseIPv4, inlining the hex number
		// parsing yields a significant performance increase.
		let off = 0;
		let acc = 0;
		for (; off < s.length; off++) {
			const c = s.charCodeAt(off);
			if (c >= 0x30 && c <= 0x39) {
				acc = acc * 16 + (c - 0x30);
			} else if (c >= 0x61 && c <= 0x66) {
				acc = acc * 16 + (c - 0x61 + 10);
			} else if (c >= 0x41 && c <= 0x46) {
				acc = acc * 16 + (c - 0x41 + 10);
			} else {
				break;
			}
			if (off > 3) {
				//more than 4 digits in group, fail.
				throw parseAddrError(input, "each group must have 4 or less digits", s);
			}
			if (acc > 0xffff) {
				// Overflow, fail.
				throw parseAddrError(input, "IPv6 field has value >=2^16", s);
			}
		}
		if (off === 0) {
			// No digits found, fail.
			throw parseAddrError(input, "each colon-separated field must have at least one digit", s);
		}

		// If followed by dot, might be in trailing IPv4.
		if (off < s.length && s[off] === ".") {
			if (ellipsis < 0 && i !== 12) {
				// Not the right place.
				throw parseAddrError(input, "embedded IPv4 address must replace the final 2 fields of the address", s);
			}
			if (i + 4 > 16) {
				// Not enough room.
				throw parseAddrError(input, "too many hex fields to fit an embedded IPv4 at the end of the address", s);
			}

			let end = input.length;
			if (zone.length > 0) {
				end -= zone.length + 1;
			}
			parseIPv4Fields(input, end - s.length, end);
			s = "";
			i += 4;
			break;
		}

		// Save this 16-bit chunk.
		i += 2;

		// Stop at end of string.
		s = s.slice(off);
		if (s.length === 0) {
			break;
		}

		// Otherwise must be followed by colon and more.
		if (s[0] !== ":") {
			throw parseAddrError(input, "unexpected character, want colon", s);
		} else if (s.length === 1) {
			throw parseAddrError(input, "colon must be followed by more characters", s);
		}
		s = s.slice(1);

		// Look for ellipsis.
		if (s[0] === ":") {
			if (ellipsis >= 0) {
				// already have one
				throw parseAddrError(input, "multiple :: in address", s);
			}
			ellipsis = i;
			s = s.slice(1);
			if (s.length === 0) {
				// can be at end
				break;
			}
		}
	}

	// Must have used entire string.
	if (s.length !== 0) {
		throw parseAddrError(input, "trailing garbage after address", s);
	}

	// If didn't parse enough, expand ellipsis.
	if (i < 16) {
		if (ellipsis < 0) {
			throw parseAddrError(input, "address string too short");
		}
	} else if (ellipsis >= 0) {
		// Ellipsis must represent at least one 0 group.
		throw parseAddrError(input, "the :: must expand to at least one field of zeros");
	}
}

/**
 * pathJoin joins any number of path elements into a single path,
 * separating them with slashes. Empty elements are ignored.
 * The result is Cleaned. However, if the argument list is
 * empty or all its elements are empty, Join returns
 * an empty string.
 *
 * Derived from path (path.go, `Join`).
 */
function pathJoin(...elem: string[]): string {
	let size = 0;
	for (const e of elem) {
		size += e.length;
	}
	if (size === 0) {
		return "";
	}
	let buf = "";
	for (const e of elem) {
		if (buf.length > 0 || e !== "") {
			if (buf.length > 0) {
				buf += "/";
			}
			buf += e;
		}
	}
	return pathClean(buf);
}

/**
 * pathClean returns the shortest path name equivalent to path
 * by purely lexical processing. It applies the following rules
 * iteratively until no further processing can be done:
 *
 *  1. Replace multiple slashes with a single slash.
 *  2. Eliminate each . path name element (the current directory).
 *  3. Eliminate each inner .. path name element (the parent directory)
 *     along with the non-.. element that precedes it.
 *  4. Eliminate .. elements that begin a rooted path:
 *     that is, replace "/.." by "/" at the beginning of a path.
 *
 * The returned path ends in a slash only if it is the root "/".
 *
 * If the result of this process is an empty string, Clean
 * returns the string ".".
 *
 * Derived from path (path.go, `Clean`). Port note: Go's lazybuf, which avoids allocating
 * when the path is already clean, is an array of the bytes written so far.
 */
function pathClean(path: string): string {
	if (path === "") {
		return ".";
	}

	const rooted = path[0] === "/";
	const n = path.length;

	// Invariants:
	//	reading from path; r is index of next byte to process.
	//	writing to buf; w is index of next byte to write.
	//	dotdot is index in buf where .. must stop, either because
	//		it is the leading slash or it is a leading ../../.. prefix.
	const out: string[] = [];
	let w = 0;
	const append = (c: string): void => {
		out[w] = c;
		w++;
	};
	let r = 0;
	let dotdot = 0;
	if (rooted) {
		append("/");
		r = 1;
		dotdot = 1;
	}

	while (r < n) {
		if (path[r] === "/") {
			// empty path element
			r++;
		} else if (path[r] === "." && (r + 1 === n || path[r + 1] === "/")) {
			// . element
			r++;
		} else if (path[r] === "." && path[r + 1] === "." && (r + 2 === n || path[r + 2] === "/")) {
			// .. element: remove to last /
			r += 2;
			if (w > dotdot) {
				// can backtrack
				w--;
				while (w > dotdot && out[w] !== "/") {
					w--;
				}
			} else if (!rooted) {
				// cannot backtrack, but not rooted, so append .. element.
				if (w > 0) {
					append("/");
				}
				append(".");
				append(".");
				dotdot = w;
			}
		} else {
			// real path element.
			// add slash if needed
			if ((rooted && w !== 1) || (!rooted && w !== 0)) {
				append("/");
			}
			// copy element
			for (; r < n && path[r] !== "/"; r++) {
				append(path[r] as string);
			}
		}
	}

	// Turn empty string into "."
	if (w === 0) {
		return ".";
	}

	return out.slice(0, w).join("");
}
