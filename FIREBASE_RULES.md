# มนุษย์หมาป่า Ultimate Extreme — Firebase Security Rules

> ⚠️ **สำคัญ**: ต้องตั้งค่า Firebase ก่อนเล่น

---

## 1. เปิดใช้งาน Anonymous Authentication

1. ไปที่ [Firebase Console](https://console.firebase.google.com/)
2. เลือกโปรเจกต์ **werewolf-3549d**
3. ไปที่ **Authentication → Sign-in method**
4. เปิดใช้งาน **"Anonymous"** provider
5. Save

---

## 2. ตั้งค่า Realtime Database Rules

ไปที่: **Firebase Console → Realtime Database → Rules**

```json
{
  "rules": {
    "werewolf": {
      "rooms": {
        "$roomId": {
          ".read": "auth != null",
          ".write": "auth != null",
          "players": {
            "$playerId": {
              ".read": "auth != null",
              ".write": "auth != null"
            }
          },
          "nightActions": {
            ".read": "auth != null",
            ".write": "auth != null"
          },
          "chat": {
            "$messageId": {
              ".read": "auth != null",
              ".write": "auth != null"
            }
          },
          "privateData": {
            "$playerId": {
              ".read": "auth != null && auth.uid === $playerId",
              ".write": "auth != null"
            }
          }
        }
      }
    }
  }
}
```

---

## หมายเหตุ

- **Anonymous Auth** ต้องเปิดก่อน ไม่งั้นเกม login ไม่ได้
- Rules ใน `privateData` — ใครก็เขียนได้ แต่อ่านได้แค่เจ้าของข้อมูล (seer result เป็น private)
- ในโค้ดจริง มีการกรอง `isHost` ก่อนทำทุก action สำคัญ
