# MathCAT: Math Capable Assistive Technology

<img src="logo-inline.png" style="height: 5.25em; vertical-align: -0.13em; margin-right: -0.25em;" alt="Logo for MathCAT. a brown cat sits upright. Its tail swoops down to form the capital letter C in the word MathCAT."> is a library that supports conversion of MathML to:


* Speech strings (in several languages) with embedded speech engine commands
* Braille (Nemeth, UEB Technical, CMU, and many others)
* Navigation of math (in multiple ways including overviews)


There are four related projects that make use of MathCAT:
- [MathCATDemo](https://nsoiffer.github.io/MathCATDemo/) -- an online demonstration of some of what can be done with MathCAT
- [A python interface for MathCAT](https://github.com/NSoiffer/MathCATForPython) -- used by a [MathCAT NVDA add-on](https://addons.nvda-project.org/addons/MathCAT.en.html).
- [A C/C++ interface for MathCAT](https://github.com/NSoiffer/MathCATForC)
- [A Java interface for MathCAT](https://github.com/mwhapples/MathCAT4J) (thanks to Michael Whapples for working on that)

MathCAT is used in many assistive technologies including NVDA and JAWS.

For more information, see the [full documentation](https://daisy.github.io/MathCAT/).

## MathCAT Workbench

From the repository root, run `cargo run --bin mathcat-workbench`. The browser opens automatically, and the program prints the local URL as a fallback. The workbench displays MathML, speech, SSML, braille, the intent tree, and engine messages. Its Expression tree view connects selected canonical nodes to source and intent MathML, in-context speech, and braille. MathCAT navigation in the tree follows the engine’s focused node; Shift+arrow keys navigate while unmodified arrows browse the visible tree. The browser reads navigation and selected-node speech aloud, with Play and Stop controls for replay. Browser voices may render MathCAT speech differently from its SSML. The workbench also offers a Reload Rules button for local YAML edits.

Use `cargo run --bin mathcat-workbench -- --rules-dir /path/to/Rules --port 8080` to choose a different rules directory or port. The default port is selected automatically.
