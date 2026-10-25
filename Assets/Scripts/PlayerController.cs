using UnityEngine;

// La boule du joueur : déplacement relatif à la caméra, saut et dash.
[RequireComponent(typeof(Rigidbody))]
public class PlayerController : MonoBehaviour
{
    public float moveForce = 28f;
    public float maxSpeed = 11f;
    public float jumpImpulse = 7f;
    public float dashImpulse = 16f;
    public float dashCooldown = 1.2f;
    public float dashDuration = 0.4f;

    public Transform cameraRef;
    public bool controlsEnabled = true;

    Rigidbody rb;
    Vector3 input;
    bool jumpQueued, dashQueued;
    float nextDash, dashEnd;

    public bool IsDashing => Time.time < dashEnd;
    public float DashCharge => dashCooldown <= 0f ? 1f : Mathf.Clamp01(1f - (nextDash - Time.time) / dashCooldown);

    bool Grounded => Physics.Raycast(transform.position, Vector3.down, 0.6f, ~0, QueryTriggerInteraction.Ignore);

    void Awake() => rb = GetComponent<Rigidbody>();

    void Update()
    {
        if (!controlsEnabled)
        {
            input = Vector3.zero;
            return;
        }

        float h = Input.GetAxisRaw("Horizontal");
        float v = Input.GetAxisRaw("Vertical");
        if (MobileInput.Move.sqrMagnitude > h * h + v * v)
        {
            h = MobileInput.Move.x;
            v = MobileInput.Move.y;
        }
        Vector3 fwd = cameraRef != null ? Vector3.ProjectOnPlane(cameraRef.forward, Vector3.up).normalized : Vector3.forward;
        Vector3 right = Vector3.Cross(Vector3.up, fwd);
        input = Vector3.ClampMagnitude(fwd * v + right * h, 1f);

        if (Input.GetButtonDown("Jump") || MobileInput.JumpDown) jumpQueued = true;
        // Sur mobile, les touchers simulent la souris : on ignore alors le clic gauche.
        bool mouseDash = !MobileInput.Enabled && Input.GetMouseButtonDown(0);
        if (Input.GetKeyDown(KeyCode.LeftShift) || mouseDash || MobileInput.DashDown) dashQueued = true;
    }

    void FixedUpdate()
    {
        Vector3 vel = rb.GetVelocity();
        Vector3 flat = new Vector3(vel.x, 0f, vel.z);

        // On n'accélère que si on ne dépasse pas la vitesse max dans la direction voulue.
        if (Vector3.Dot(flat, input) < maxSpeed)
            rb.AddForce(input * moveForce, ForceMode.Acceleration);

        if (jumpQueued)
        {
            if (Grounded) rb.AddForce(Vector3.up * jumpImpulse, ForceMode.Impulse);
            jumpQueued = false;
        }

        if (dashQueued)
        {
            if (Time.time >= nextDash)
            {
                Vector3 dir = input.sqrMagnitude > 0.01f ? input
                            : flat.sqrMagnitude > 0.5f ? flat.normalized
                            : Vector3.ProjectOnPlane(cameraRef.forward, Vector3.up).normalized;
                rb.AddForce(dir * dashImpulse, ForceMode.Impulse);
                dashEnd = Time.time + dashDuration;
                nextDash = Time.time + dashCooldown;
            }
            dashQueued = false;
        }
    }

    public void ResetAt(Vector3 pos)
    {
        transform.position = pos;
        rb.SetVelocity(Vector3.zero);
        rb.angularVelocity = Vector3.zero;
    }
}
