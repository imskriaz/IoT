# A76XX `AT+CUSD` Reference

Source PDF:

- [A76XX_Series_AT_Command_Manual_V1.09.pdf](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e/manuals/A76XX_Series_AT_Command_Manual_V1.09.pdf)

Source pages:

- PDF pages `87-89`
- footer pages `86-88 / 652`

## Purpose

`AT+CUSD` controls Unstructured Supplementary Service Data (`USSD`) operations on the A76XX modem family.

The vendor manual states that both mobile-initiated and network-initiated operations are supported. The modem reports USSD responses with the unsolicited result code:

```text
+CUSD: <m>[,<str>,<dcs>]
```

The same command family is also used to cancel an active session.

## Command Forms

Test:

```text
AT+CUSD=?
+CUSD: (range of supported <n>s)
```

Read:

```text
AT+CUSD?
+CUSD: <n>
```

Write:

```text
AT+CUSD=<n>[,<str>[,<dcs>]]
```

Execute:

```text
AT+CUSD
```

The execution form resets the default to `<n>=0`.

## Defined Values

`<n>`:

- `0`: disable result code presentation
- `1`: enable result code presentation
- `2`: cancel the ongoing USSD session

`<str>`:

- USSD string payload

`<dcs>`:

- Cell Broadcast Data Coding Scheme
- vendor manual default: `17`

`<m>` in `+CUSD` URCs:

- `0`: no further user action required
- `1`: further user action required
- `2`: USSD terminated by network
- `4`: operation not supported
- `5`: network time out

## Session Handling

The manual does not define a separate "reply to session menu" command. The session continuation model is implied by the same `AT+CUSD` write command plus the `+CUSD: <m>` unsolicited result.

Practical reading of the vendor contract:

- Send an initial USSD request with `AT+CUSD=1,"<code>"[,<dcs>]`
- If the modem returns `+CUSD: 1,...`, the network still expects user input
- Send the next menu choice as another `AT+CUSD=1,"<reply>"[,<dcs>]`
- Cancel the active session with `AT+CUSD=2`

## IMS Note

The manual includes an implementation note for modules that support IMS:

```text
at*imsrcfg="switch"
```

If the module reports IMS switch `"on"`, the manual says to switch IMS off before using `AT+CUSD`, otherwise `AT+CUSD` may return `ERROR`.

## Repo Runtime Note

The current ESP32 firmware intentionally sends:

```text
AT+CUSD=1,"<code>",15
```

See [modem_a7670_telephony.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/modem_a7670/src/modem_a7670_telephony.c:941).

That local implementation note says:

- Robi chained replies require the same DCS as the root request
- omitting `,15` on digit-only follow-ups leaves the session hanging

This is stricter than the vendor manual's generic default `17`, so treat the firmware behavior as an operator-specific interoperability workaround rather than a contradiction in the base command syntax.

## Extracted Text

Normalized from the vendor PDF section around `4.2.3 AT+CUSD`.

```text
This command allows control of the Unstructured Supplementary Service Data (USSD).
Both network and mobile initiated operations are supported.
Parameter <n> is used to disable/enable the presentation of an unsolicited
result code (USSD response from the network, or network initiated operation):

+CUSD: <m>[,<str>,<dcs>]

In addition, value <n>=2 is used to cancel an ongoing USSD session.

Write Command:
AT+CUSD=<n>[,<str>[,<dcs>]]

Defined Values:
<n> 0 disable the result code presentation in the TA
<n> 1 enable the result code presentation in the TA
<n> 2 cancel session

<dcs> Cell Broadcast Data Coding Scheme in integer format (default 17)

<m> 0 no further user action required
<m> 1 further user action required
<m> 2 USSD terminated by network
<m> 4 operation not supported
<m> 5 network time out
```
