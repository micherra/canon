# T2 Probe Results — `leave-touched-files-better`

**Verdict: INCONCLUSIVE**

- Recall: 0.000 (0 retrievable positives)
- False-positive rate: 0.000 (0 retrievable negatives)
- Excluded (diff_unavailable): 96
- Checker failed-open count: 0

**Conservative negative set caveat**: the negative set is every review without a recorded violation for this principle (DESIGN ASSUMPTION 3) — this over-counts false positives, biasing against the checker, so a PASS verdict here is trustworthy.

## Per-build join table

| review_id | reviewer_flagged | checker_flagged | failed_open | diff_available |
|---|---|---|---|---|
| rev_20260525_75e5557ca1186542 | true | false | false | false |
| rev_20260525_6c1f479b42e8e266 | true | false | false | false |
| rev_20260530_88def4c30977b407 | true | false | false | false |
| rev_20260605_2c0c7faeef7b492f | true | false | false | false |
| rev_20260605_0448c6415aba6239 | true | false | false | false |
| rev_20260608_10b66b38d0406142 | true | false | false | false |
| rev_20260401_e93ffb5493db0008 | false | false | false | false |
| rev_20260401_e6fc74d32bf93a19 | false | false | false | false |
| rev_20260401_ca5d368ab73ba338 | false | false | false | false |
| rev_20260402_9597712b715b1294 | false | false | false | false |
| rev_20260403_1f296b81b002fc41 | false | false | false | false |
| rev_20260404_c8f39f6896e5902b | false | false | false | false |
| rev_20260407_69807a079a6e9ccf | false | false | false | false |
| rev_20260408_e5ff5bbbf5a78b42 | false | false | false | false |
| rev_20260408_bcdb8fb4b13198b4 | false | false | false | false |
| rev_20260408_59eb55d9507794cd | false | false | false | false |
| rev_20260408_99fc772662c5b44f | false | false | false | false |
| rev_20260409_18d84100fd286cef | false | false | false | false |
| rev_20260409_a1b1e19143705f3c | false | false | false | false |
| rev_20260409_984d13ffd6339776 | false | false | false | false |
| rev_20260409_50464714e30e9541 | false | false | false | false |
| rev_20260409_0a54e91aeaac86ec | false | false | false | false |
| rev_20260516_e03327b331df6df8 | false | false | false | false |
| rev_20260516_45b6f0901cc9a86b | false | false | false | false |
| rev_20260522_f47b84f4ce09d0b1 | false | false | false | false |
| rev_20260523_c163bdb3825c0322 | false | false | false | false |
| rev_20260523_b0f679db19dbfded | false | false | false | false |
| rev_20260523_95434e9d01029480 | false | false | false | false |
| rev_20260524_a4eb9aa9ad806166 | false | false | false | false |
| rev_20260524_ad70dd88f5855d14 | false | false | false | false |
| rev_20260525_e2100b61fe322e1e | false | false | false | false |
| rev_20260525_0325ffccc83a95e9 | false | false | false | false |
| rev_20260525_d6c71d64c1cb117a | false | false | false | false |
| rev_20260525_c6745c913a38ee35 | false | false | false | false |
| rev_20260525_c830948d2f5b3a67 | false | false | false | false |
| rev_20260525_63c98fc71e87b219 | false | false | false | false |
| rev_20260525_4448c00ea2ca4ab0 | false | false | false | false |
| rev_20260525_ecda48df9f405017 | false | false | false | false |
| rev_20260525_3394de14e9e2311e | false | false | false | false |
| rev_20260525_32024d07e264908e | false | false | false | false |
| rev_20260525_2a2e7a872d130776 | false | false | false | false |
| rev_20260525_fa1ae410db8de7c5 | false | false | false | false |
| rev_20260525_01baacd873be4024 | false | false | false | false |
| rev_20260526_0bdff5b95e52afbf | false | false | false | false |
| rev_20260526_45aa7bdd428246c4 | false | false | false | false |
| rev_20260526_1e99a13084d8fc37 | false | false | false | false |
| rev_20260527_a9d28e70692ba1ea | false | false | false | false |
| rev_20260527_1338c2d686ca07da | false | false | false | false |
| rev_20260527_6ac3c9ddfbb835cd | false | false | false | false |
| rev_20260527_3fed5fefc050a425 | false | false | false | false |
| rev_20260527_b8eb276bbc0700e2 | false | false | false | false |
| rev_20260527_6d3393677a326f90 | false | false | false | false |
| rev_20260527_4ff5da44008c9775 | false | false | false | false |
| rev_20260527_0479a7e2bdaa4931 | false | false | false | false |
| rev_20260527_b7f10dacbb47ac87 | false | false | false | false |
| rev_20260529_a107565cab3bed93 | false | false | false | false |
| rev_20260529_bbe0b66066bdd68e | false | false | false | false |
| rev_20260529_943fa045006c47d2 | false | false | false | false |
| rev_20260529_ca3de273517b9c91 | false | false | false | false |
| rev_20260529_fddf1c6914ae16de | false | false | false | false |
| rev_20260529_2b7294bfd250be10 | false | false | false | false |
| rev_20260529_26e2b55a4bac52a6 | false | false | false | false |
| rev_20260529_6f3dfcc48680ad75 | false | false | false | false |
| rev_20260529_aaebbef5165b8237 | false | false | false | false |
| rev_20260603_c351cea712d1a638 | false | false | false | false |
| rev_20260603_547bd530deec902d | false | false | false | false |
| rev_20260603_6e415c5262ceaa55 | false | false | false | false |
| rev_20260604_de359e2d58329cbb | false | false | false | false |
| rev_20260604_00af2745e96c157c | false | false | false | false |
| rev_20260604_5bc3c772f875afdf | false | false | false | false |
| rev_20260605_bdc7ae527166547a | false | false | false | false |
| rev_20260605_048b294465251d73 | false | false | false | false |
| rev_20260605_c34989500363433a | false | false | false | false |
| rev_20260605_89d0a5dba5a40df6 | false | false | false | false |
| rev_20260605_f4e8b620cd1956b4 | false | false | false | false |
| rev_20260605_d1db6131ddf862ed | false | false | false | false |
| rev_20260605_717f457a11a5b94c | false | false | false | false |
| rev_20260605_3dfbd764835f5391 | false | false | false | false |
| rev_20260605_fbab7884f409331d | false | false | false | false |
| rev_20260605_257c1fff2d6f941a | false | false | false | false |
| rev_20260606_86fb2521b0aa31a1 | false | false | false | false |
| rev_20260606_1714d1de975fe176 | false | false | false | false |
| rev_20260607_823b0dff173b01fc | false | false | false | false |
| rev_20260607_361fd55beab3a0af | false | false | false | false |
| rev_20260607_1e35a236391cc829 | false | false | false | false |
| rev_20260607_7ce5780c42168f0d | false | false | false | false |
| rev_20260608_a29da4d87615d8fb | false | false | false | false |
| rev_20260610_fac2873c9f3fe970 | false | false | false | false |
| rev_20260610_216fa780f0ec21c2 | false | false | false | false |
| rev_20260612_70864b78fb02a4d0 | false | false | false | false |
| rev_20260612_ec36e1d69cfcceb3 | false | false | false | false |
| rev_20260612_bbe34b695c86ffa3 | false | false | false | false |
| rev_20260622_8b86240e0071c851 | false | false | false | false |
| rev_20260622_e68951fb6feb3699 | false | false | false | false |
| rev_20260702_7c1366f44e6be67d | false | false | false | false |
| rev_20260705_9092cea14e2d7b2d | false | false | false | false |
