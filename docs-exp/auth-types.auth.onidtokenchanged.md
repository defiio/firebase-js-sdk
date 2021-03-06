<!-- Do not edit this file. It is automatically generated by API Documenter. -->

[Home](./index.md) &gt; [@firebase/auth-types](./auth-types.md) &gt; [Auth](./auth-types.auth.md) &gt; [onIdTokenChanged](./auth-types.auth.onidtokenchanged.md)

## Auth.onIdTokenChanged() method

Adds an observer for changes to the signed-in user's ID token.

<b>Signature:</b>

```typescript
onIdTokenChanged(
    nextOrObserver: NextOrObserver<User>,
    error?: ErrorFn,
    completed?: CompleteFn
  ): Unsubscribe;
```

## Parameters

|  Parameter | Type | Description |
|  --- | --- | --- |
|  nextOrObserver | [NextOrObserver](./auth-types.nextorobserver.md)<!-- -->&lt;[User](./auth-types.user.md)<!-- -->&gt; | callback triggered on change. |
|  error | ErrorFn | callback triggered on error. |
|  completed | CompleteFn | callback triggered when observer is removed. |

<b>Returns:</b>

Unsubscribe

## Remarks

This includes sign-in, sign-out, and token refresh events.

