# GMN Image Captioner

GMN Image Captioner is an image caption tool that uses Gemini Vision. Utilize the settings provided by Gemini to get better, more desirable answers.

## Features

- Caption images from any page with the right click menu.
- Upload images or paste them directly from the clipboard.
- Preview the exact payload JSON before sending.
- Copy the generated result.
- Save, load, rename, and delete presets.
- Export and import settings as JSON.
- Change the order of payload blocks.
- Use Grid and Glitch vision modes.
- Work with Gemini and Gemma models.

## Setup

- Download or clone this repo.
- Open Chrome and go to the extensions page.
- Turn on Developer mode.
- Load this folder as an unpacked extension.
- Add your Gemini API key in the extension panel.

## How To Use

- Open the extension panel from the toolbar.
- Set your API key, model, system prompt, and main prompt.
- Use Preset Manager at the top of the panel to save your setup for later.
- Click Preview Payload JSON to check the request before sending.
- Right click an image and choose Caption with GMN.
- Copy the result from the output area when it is ready.

## Prompt Engineering Tools

- Search Grounding allows the model to perform Google text searches to gather extra information about subjects it identifies. Note: It cannot do reverse image searches and is not supported by Flash or Flash-Lite 3 models.
- CoT Injection adds a reasoning style user block. Turn it on when you want the extra text to appear before the image prompt.
- Context Padding adds a fake chat history with User and Model lines. Keep the text in that format when you edit it.
- Disable/Minimize Thinking changes the model thinking setting for supported Gemini models. Turn it on when you want less thinking from the model.
- Auto Prompt Encoding uses Base64 for the prompt text. Edit the text box under it if you want to change the encoded instruction.
- Braille Spacing replaces normal spaces in the system prompt with Braille space. Use Clean Braille Spaces on Copy if you want normal text when copying the output.
- CoT Emulation adds a full think block with both the opening and closing part. Use the text box under it to edit the block.
- Thinking Seed adds only the opening think block so the model can continue it. Use it when you want a lighter seed than CoT Emulation.

## Vision Modes

- Grid splits the image into 2 by 2 or 3 by 3 pieces and reverses the tiles before sending it.
- Glitch adds a noise style overlay to the image before sending it.
- The Base64 note option in each tab changes how the helper note is sent with the request.

## JSON And Presets

- Export Config downloads your current settings as a JSON file.
- Import Config loads settings back from a JSON file.
- Imported JSON can also include presets.
- Presets let you keep different setups for different images or prompts.

## Notes

- This extension needs a valid Gemini API key.
- No build step is needed. Load the folder directly in Chrome.