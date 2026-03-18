# Remote CW Setup Guide

This guide covers how to set up remote CW keying through ECHOCAT (POTACAT's phone remote feature) using DTR serial keying.

## Overview

ECHOCAT can key your rig's CW via a USB serial port's DTR pin. This works with any rig that supports CW keying from a USB DTR line, including the QRP Labs QMX/QMX+, and rigs with external USB-to-serial keying adapters.

---

## QRP Labs QMX / QMX+ Setup

*Contributed by Walt KK4DF*

### POTACAT Settings

1. **Radio Connection (Settings > Radio)**
   - Type: **Serial CAT (Kenwood)**
   - Port: First QMX USB serial port (e.g. COM3)
   - Baud Rate: **38400**
   - Check **"Disable DTR/RTS on connect"** (important — prevents the CAT port from keying CW)

2. **ECHOCAT Audio (Settings > ECHOCAT)**
   - Audio Input: **Digital Audio Interface (QMX Transceiver)**
   - Audio Output: **Digital Audio Interface (QMX Transceiver)**

3. **CW Key Port (Settings > ECHOCAT)**
   - CW Key Port (DTR Keying): Select the **second** QMX USB serial port (e.g. COM4)

### QMX Radio Configuration

1. **Enable dual serial ports:**
   - Navigate to **System > GPS&Ser.Ports**
   - Set **Serial Ports** to **2**
   - Restart the QMX (the second COM port will appear in Windows Device Manager)

2. **Configure CW keying from USB:**
   - Navigate to **CW > CWKeyer**
   - Set **Key from USB DTR** to **USB 2**

### Finding the Second COM Port

After setting Serial Ports to 2 and restarting the QMX, open **Windows Device Manager > Ports (COM & LPT)**. You'll see two ports for the QMX — the lower-numbered one is typically the CAT port, and the higher-numbered one is the CW keying port.

---

## General DTR CW Keying Setup

For other rigs using an external USB-to-serial adapter for CW keying:

### POTACAT Settings

1. **Radio Connection** — Configure your rig's CAT control as normal (TCP, serial, or rigctld)

2. **CW Key Port (Settings > ECHOCAT)**
   - Set **CW Key Port (DTR Keying)** to the COM port of your USB-to-serial adapter
   - The adapter's DTR pin should be wired to your rig's key input

### Wiring

Connect the USB-to-serial adapter's **DTR** pin to your rig's CW key jack (tip = key, sleeve = ground). A simple circuit with a 2N2222 transistor or optocoupler is recommended to protect both devices.

---

## Troubleshooting

- **No CW output:** Verify the CW Key Port is set to the correct COM port. Check that DTR keying is enabled on the rig side.
- **CAT port keys CW unexpectedly:** Make sure "Disable DTR/RTS on connect" is checked for the CAT serial connection.
- **Second COM port not appearing (QMX):** Restart the QMX after changing the Serial Ports setting to 2. The new port appears after reboot.
- **CW keying is inverted:** Some adapters idle DTR high. Check your rig's keying polarity setting if available.
