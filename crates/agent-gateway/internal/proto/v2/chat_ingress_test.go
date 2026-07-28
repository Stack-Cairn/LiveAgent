package gatewayv2

import (
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

func TestChatIngressWireFieldNumbers(t *testing.T) {
	tests := []struct {
		message protoreflect.MessageDescriptor
		field   protoreflect.Name
		want    protoreflect.FieldNumber
	}{
		{(&ClientHello{}).ProtoReflect().Descriptor(), "capabilities", 8},
		{(&ServerHello{}).ProtoReflect().Descriptor(), "capabilities", 7},
		{(&GatewayEnvelope{}).ProtoReflect().Descriptor(), "chat_ingress_ack", 75},
		{(&AgentEnvelope{}).ProtoReflect().Descriptor(), "chat_ingress_batch", 95},
		{(&AgentEnvelope{}).ProtoReflect().Descriptor(), "chat_ingress_resume", 96},
		{(&AgentEnvelope{}).ProtoReflect().Descriptor(), "chat_ingress_fragment", 97},
	}

	for _, test := range tests {
		field := test.message.Fields().ByName(test.field)
		if field == nil {
			t.Fatalf("%s.%s is missing", test.message.Name(), test.field)
		}
		if got := field.Number(); got != test.want {
			t.Fatalf("%s.%s number = %d, want %d", test.message.Name(), test.field, got, test.want)
		}
	}
}

func TestChatIngressRecordRoundTrip(t *testing.T) {
	want := &AgentEnvelope{
		Payload: &AgentEnvelope_ChatIngressBatch{
			ChatIngressBatch: &ChatIngressBatch{
				RunId:          "run-1",
				ConversationId: "conversation-1",
				FirstSeq:       9,
				Records: []*ChatIngressRecord{{
					Payload: &ChatIngressRecord_Terminal{
						Terminal: &ChatIngressTerminal{
							CoversThroughSeq:     8,
							Revision:             3,
							CompressedProjection: []byte("projection"),
							UncompressedBytes:    64,
							Sha256:               "sha256",
							ContentComplete:      true,
							HistoryRequired:      true,
							State:                "completed",
						},
					},
				}},
			},
		},
	}

	encoded, err := proto.Marshal(want)
	if err != nil {
		t.Fatalf("marshal chat ingress envelope: %v", err)
	}
	got := &AgentEnvelope{}
	if err := proto.Unmarshal(encoded, got); err != nil {
		t.Fatalf("unmarshal chat ingress envelope: %v", err)
	}
	if !proto.Equal(got, want) {
		t.Fatalf("round trip mismatch:\n got: %v\nwant: %v", got, want)
	}
}
